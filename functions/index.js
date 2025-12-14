const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

// Configurações globais (Memória e Timeout para tarefas pesadas)
setGlobalOptions({ 
    maxInstances: 10,
    region: 'us-central1',
    memory: '1GiB', 
    timeoutSeconds: 540 
});

const DEFAULT_APP_ID = '1:56272587692:web:6e62374b91269073784809';

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: "akkoacademycontato@gmail.com",
        pass: "fhhb efdx lzep jzvi",
    },
});

// --- HELPER: Geradores ---
const generateUniqueCode = () => {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = "AK-";
    for(let i=0; i<6; i++) code += chars.charAt(Math.floor(Math.random() * chars.length));
    return code;
};

const generateTempPassword = () => {
    return Math.random().toString(36).slice(-8) + "Aa1"; 
};

// ==================================================================
// NOVO: IMPERSONATION (LOGIN COMO OUTRO USUÁRIO)
// ==================================================================
exports.getImpersonationToken = onCall(async (request) => {
    // Segurança: Verifica se quem está pedindo é o admin (Opcional, mas recomendado)
    // if (!request.auth || request.auth.token.email !== 'admin@akko.com') {
    //    throw new HttpsError('permission-denied', 'Apenas admins podem fazer isso.');
    // }

    const targetUid = request.data.uid;
    if (!targetUid) throw new HttpsError('invalid-argument', 'UID necessário.');

    try {
        // Cria um token customizado que permite login sem senha
        const customToken = await admin.auth().createCustomToken(targetUid);
        return { token: customToken };
    } catch (error) {
        console.error("Erro ao gerar token:", error);
        throw new HttpsError('internal', error.message);
    }
});

// ==================================================================
// NOVO: CRIAÇÃO SEGURA DE MEMBRO (Manual / Admin)
// ==================================================================
exports.createMember = onCall(async (request) => {
    const { name, email, appId } = request.data;
    const targetAppId = appId || DEFAULT_APP_ID;
    
    try {
        const password = generateTempPassword();
        const uniqueCode = generateUniqueCode();
        let userRecord;

        // 1. Cria ou recupera usuário no Auth
        try {
            userRecord = await admin.auth().createUser({
                email: email,
                password: password,
                displayName: name,
                emailVerified: true
            });
        } catch (e) {
            if(e.code === 'auth/email-already-exists') {
                userRecord = await admin.auth().getUserByEmail(email);
            } else {
                throw e;
            }
        }

        // 2. Salva no Firestore
        await db.collection('artifacts').doc(targetAppId)
            .collection('public').doc('data')
            .collection('students').doc(userRecord.uid).set({
                uid: userRecord.uid,
                name: name,
                email: email,
                uniqueCode: uniqueCode,
                tempPassword: password, // Útil para testes/envio manual
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                accessLevel: 'student',
                origin: 'manual_creation'
            }, { merge: true });

        return { 
            success: true, 
            message: "Usuário criado com sucesso!",
            data: { email, password, uniqueCode } 
        };

    } catch (error) {
        console.error("Erro createMember:", error);
        throw new HttpsError('internal', error.message);
    }
});

// ==================================================================
// 1. WEBHOOK DE VENDAS (ATUALIZADO COM UNIQUE CODE)
// ==================================================================
exports.handleNewSale = onRequest({ cors: true }, async (req, res) => {
    try {
        const data = req.body;
        console.log("Webhook Payload:", JSON.stringify(data));

        // Normalização de campos de diferentes plataformas
        const email = data.email || data.client?.email || data.buyer_email || (data.data && data.data.buyer && data.data.buyer.email);
        const name = data.name || data.client?.name || data.buyer_name || (data.data && data.data.buyer && data.data.buyer.name);
        const status = data.status || data.transaction_status || data.event; 
        
        const invalidStatuses = ['refused', 'refunded', 'chargedback', 'canceled', 'dispute'];
        if (status && invalidStatuses.includes(status)) return res.status(200).send("Status ignorado.");
        if (!email) return res.status(400).send("Email não encontrado.");

        let userRecord;
        let passwordUsed = null;
        let uniqueCode = generateUniqueCode();

        // 1. Auth Logic
        try {
            userRecord = await admin.auth().getUserByEmail(email);
        } catch (e) {
            if (e.code === 'auth/user-not-found') {
                passwordUsed = generateTempPassword();
                userRecord = await admin.auth().createUser({
                    email: email,
                    password: passwordUsed,
                    displayName: name || 'Aluno Novo'
                });
            } else throw e;
        }

        // 2. Firestore Logic (Preserva uniqueCode se já existir)
        const docRef = db.collection('artifacts').doc(DEFAULT_APP_ID)
            .collection('public').doc('data')
            .collection('students').doc(userRecord.uid);
            
        const docSnap = await docRef.get();
        if(docSnap.exists && docSnap.data().uniqueCode) {
            uniqueCode = docSnap.data().uniqueCode;
        }

        const updateData = {
            uid: userRecord.uid,
            name: name || userRecord.displayName || 'Aluno',
            email: email,
            uniqueCode: uniqueCode,
            accessLevel: 'student',
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
        };

        if (passwordUsed) {
            updateData.tempPassword = passwordUsed;
            updateData.createdAt = admin.firestore.FieldValue.serverTimestamp();
            await sendWelcomeEmail(email, passwordUsed);
        }

        await docRef.set(updateData, { merge: true });

        return res.status(200).send("Sucesso. Venda processada.");
    } catch (error) {
        console.error("Erro Webhook:", error);
        return res.status(500).send("Erro: " + error.message);
    }
});

// ==================================================================
// 2. SINCRONIZAR AUTH (LÓGICA ORIGINAL RESTAURADA)
// ==================================================================
exports.syncAuthToFirestore = onCall(async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login necessário.');
    
    const appId = request.data.appId || DEFAULT_APP_ID;
    const studentsCollection = db.collection("artifacts").doc(appId)
        .collection("public").doc("data").collection("students");

    let nextPageToken;
    let totalImported = 0;
    let loopCount = 0;

    console.log("Iniciando sincronização...");

    try {
        // Loop DO-WHILE para pegar TODAS as páginas de usuários
        do {
            loopCount++;
            const listUsersResult = await admin.auth().listUsers(1000, nextPageToken);
            const authUsers = listUsersResult.users;
            nextPageToken = listUsersResult.pageToken;

            if (authUsers.length === 0) break;

            const refs = authUsers.map(u => studentsCollection.doc(u.uid));
            const snapshots = await db.getAll(...refs);

            const batch = db.batch();
            let batchSize = 0;

            snapshots.forEach((snap, index) => {
                if (!snap.exists) {
                    const user = authUsers[index];
                    
                    if (user.email === 'admin@akko.com') return;

                    batch.set(snap.ref, {
                        uid: user.uid,
                        email: user.email,
                        name: user.displayName || "Usuario Importado",
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        imported: true,
                        accessLevel: 'student',
                        uniqueCode: generateUniqueCode() // Adicionei isso para garantir que importados tenham código
                    });
                    batchSize++;
                    totalImported++;
                }
            });

            if (batchSize > 0) {
                await batch.commit();
                console.log(`Lote ${loopCount}: ${batchSize} novos alunos salvos.`);
            } else {
                console.log(`Lote ${loopCount}: Nenhum usuário novo nesta página.`);
            }

        } while (nextPageToken);

        return { success: true, message: `Processo finalizado! ${totalImported} novos alunos importados.` };

    } catch (error) {
        console.error("Erro fatal no Sync:", error);
        throw new HttpsError('internal', `Erro interno: ${error.message}`);
    }
});

// ==================================================================
// 3. GERAR ALUNOS DE TESTE (ORIGINAL RESTAURADO)
// ==================================================================
exports.generateMockStudents = onCall(async (request) => {
    const qty = request.data.qty || 3;
    const appId = request.data.appId || DEFAULT_APP_ID;
    const created = [];

    for(let i=0; i<qty; i++) {
        const fakeId = Math.floor(Math.random() * 100000);
        const email = `teste.lab${fakeId}@exemplo.com`;
        const pass = "teste123";
        const uniqueCode = generateUniqueCode();
        
        try {
            // Cria no Auth
            const userRecord = await admin.auth().createUser({
                email: email,
                password: pass,
                displayName: `Aluno Teste ${fakeId}`
            });

            // Cria no Banco
            await db.collection("artifacts").doc(appId)
                .collection("public").doc("data")
                .collection("students").doc(userRecord.uid).set({
                    uid: userRecord.uid,
                    name: `Aluno Teste ${fakeId}`,
                    email: email,
                    uniqueCode: uniqueCode,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    origin: "Lab Test"
                });
            
            created.push(email);
        } catch(e) {
            console.error("Erro ao criar mock:", e);
        }
    }

    return { success: true, message: `Criados ${created.length} alunos.`, emails: created };
});

// ==================================================================
// 4. UTILS
// ==================================================================
exports.deleteStudent = onCall(async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login necessário.');
    const targetUid = request.data.uid;
    const appId = request.data.appId || DEFAULT_APP_ID;

    try {
        await admin.auth().deleteUser(targetUid);
    } catch(e) { console.log("Usuário já não existia no Auth"); }
    
    try {
        await db.collection("artifacts").doc(appId).collection("public").doc("data").collection("students").doc(targetUid).delete();
    } catch(e) {}

    return { success: true, message: "Aluno deletado!" };
});

exports.sendCustomRecoveryEmail = onCall(async (request) => {
    const email = request.data.email;
    if (!email) throw new HttpsError('invalid-argument', 'Email obrigatório.');
    try {
        const link = await admin.auth().generatePasswordResetLink(email);
        await transporter.sendMail({ from: '"Akko" <contato@akko.com>', to: email, subject: 'Redefinir Senha', text: link });
        return { success: true };
    } catch (error) { throw new HttpsError('internal', error.message); }
});

async function sendWelcomeEmail(email, password) {
    try {
        await transporter.sendMail({
            from: '"Akko Academy" <akkoacademycontato@gmail.com>',
            to: email,
            subject: '🚀 Acesso Liberado',
            html: `<p>Login: ${email}<br>Senha: ${password}</p><a href="https://akko-academy.web.app">ACESSAR</a>`
        });
    } catch (e) { console.error(e); }
}