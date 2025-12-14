const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

// Aumentamos a memória e timeout
setGlobalOptions({ 
    maxInstances: 10,
    region: 'us-central1',
    memory: '1GiB', // Aumentado para 1GB para segurança
    timeoutSeconds: 540 // Aumentado para 9 minutos (máximo da Gen2)
});

const DEFAULT_APP_ID = '1:56272587692:web:6e62374b91269073784809';

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: "akkoacademycontato@gmail.com",
        pass: "fhhb efdx lzep jzvi",
    },
});

// ==================================================================
// 1. WEBHOOK DE VENDAS
// ==================================================================
exports.handleNewSale = onRequest({ cors: true }, async (req, res) => {
    try {
        const data = req.body;
        console.log("Webhook:", JSON.stringify(data));

        const email = data.email || data.client?.email || data.buyer_email || (data.data && data.data.buyer && data.data.buyer.email);
        const name = data.name || data.client?.name || data.buyer_name || (data.data && data.data.buyer && data.data.buyer.name);
        const status = data.status || data.transaction_status || data.event; 
        const productId = data.product_id || 'unknown';

        const invalidStatuses = ['refused', 'refunded', 'chargedback', 'canceled', 'dispute'];
        if (status && invalidStatuses.includes(status)) return res.status(200).send("Status ignorado.");
        if (!email) return res.status(400).send("Email não encontrado.");

        let userRecord;
        let isNewUser = false;
        let passwordUsed = null;

        try {
            userRecord = await admin.auth().getUserByEmail(email);
        } catch (e) {
            if (e.code === 'auth/user-not-found') {
                isNewUser = true;
                passwordUsed = Math.random().toString(36).slice(-8) + "Aa1";
                userRecord = await admin.auth().createUser({
                    email: email,
                    password: passwordUsed,
                    displayName: name || 'Aluno Novo'
                });
            } else throw e;
        }

        await db.collection('artifacts').doc(DEFAULT_APP_ID)
            .collection('public').doc('data')
            .collection('students').doc(userRecord.uid).set({
                uid: userRecord.uid,
                name: name || userRecord.displayName || 'Aluno',
                email: email,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                accessLevel: 'student',
                productId: productId
            }, { merge: true });

        if (isNewUser && passwordUsed) await sendWelcomeEmail(email, passwordUsed);

        return res.status(200).send("Sucesso.");
    } catch (error) {
        console.error("Erro Webhook:", error);
        return res.status(500).send("Erro: " + error.message);
    }
});

// ==================================================================
// 2. SINCRONIZAR AUTH (CORRIGIDO E OTIMIZADO)
// ==================================================================
exports.syncAuthToFirestore = onCall(async (request) => {
    // 1. Segurança Básica
    if (!request.auth) throw new HttpsError('unauthenticated', 'Login necessário.');
    
    const appId = request.data.appId || DEFAULT_APP_ID;
    const studentsCollection = db.collection("artifacts").doc(appId)
        .collection("public").doc("data").collection("students");

    let nextPageToken;
    let totalImported = 0;
    let loopCount = 0;

    // 2. Loop de Paginação (Garante que lê TODOS os usuários, não só 1000)
    try {
        do {
            loopCount++;
            // Pega 1000 usuários do Auth por vez
            const listUsersResult = await admin.auth().listUsers(1000, nextPageToken);
            const authUsers = listUsersResult.users;
            nextPageToken = listUsersResult.pageToken;

            if (authUsers.length === 0) break;

            // 3. Otimização: getAll() do Firestore
            // Em vez de ler o banco todo, criamos referências apenas para os 1000 atuais
            // e verificamos quais existem. Isso economiza MUITA memória.
            const refs = authUsers.map(u => studentsCollection.doc(u.uid));
            const snapshots = await db.getAll(...refs);

            const batch = db.batch();
            let batchSize = 0;

            // 4. Comparação
            snapshots.forEach((snap, index) => {
                // Se o documento NÃO existe, adicionamos ao batch para criar
                if (!snap.exists) {
                    const user = authUsers[index];
                    
                    // Ignora o admin para não poluir a lista de alunos
                    if (user.email === 'admin@akko.com') return;

                    batch.set(snap.ref, {
                        uid: user.uid,
                        email: user.email,
                        name: user.displayName || "Usuario Importado",
                        createdAt: admin.firestore.FieldValue.serverTimestamp(),
                        imported: true,
                        accessLevel: 'student'
                    });
                    batchSize++;
                    totalImported++;
                }
            });

            // 5. Executa o lote se houver algo para gravar
            if (batchSize > 0) {
                await batch.commit();
                console.log(`Lote ${loopCount}: ${batchSize} novos alunos importados.`);
            }

        } while (nextPageToken);

        return { success: true, message: `Sincronização concluída! ${totalImported} novos alunos adicionados.` };

    } catch (error) {
        console.error("Erro fatal no Sync:", error);
        throw new HttpsError('internal', `Erro interno: ${error.message}`);
    }
});

// ==================================================================
// 3. GERAR ALUNOS DE TESTE
// ==================================================================
exports.generateMockStudents = onCall(async (request) => {
    const qty = request.data.qty || 3;
    const appId = request.data.appId || DEFAULT_APP_ID;
    const created = [];

    for(let i=0; i<qty; i++) {
        const fakeId = Math.floor(Math.random() * 100000);
        const email = `teste.lab${fakeId}@exemplo.com`;
        const pass = "teste123";
        
        try {
            const userRecord = await admin.auth().createUser({
                email: email,
                password: pass,
                displayName: `Aluno Teste ${fakeId}`
            });

            await db.collection("artifacts").doc(appId)
                .collection("public").doc("data")
                .collection("students").doc(userRecord.uid).set({
                    uid: userRecord.uid,
                    name: `Aluno Teste ${fakeId}`,
                    email: email,
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
        try {
            await db.collection("artifacts").doc(appId).collection("public").doc("data").collection("students").doc(targetUid).delete();
        } catch(e) {}
        return { success: true, message: "Aluno deletado!" };
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
             await db.collection("artifacts").doc(appId).collection("public").doc("data").collection("students").doc(targetUid).delete();
             return { success: true, message: "Limpeza concluída." };
        }
        throw new HttpsError('internal', error.message);
    }
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