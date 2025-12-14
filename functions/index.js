/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// --- IMPORTS ATUALIZADOS PARA GEN 2 ---
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

// Inicializa Admin SDK
admin.initializeApp();
const db = admin.firestore();

// Configuração Global (Evita erros de CPU/Região)
setGlobalOptions({ 
    maxInstances: 10,
    region: 'us-central1',
    memory: '256MiB',
    timeoutSeconds: 60
});

const DEFAULT_APP_ID = '1:56272587692:web:6e62374b91269073784809';

// Configuração de Email
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: "akkoacademycontato@gmail.com",
        pass: "fhhb efdx lzep jzvi",
    },
});

// ==================================================================
// 1. WEBHOOK DE VENDAS (Gen 2)
// ==================================================================
exports.handleNewSale = onRequest({ cors: true }, async (req, res) => {
    try {
        const data = req.body;
        console.log("Webhook Payload:", JSON.stringify(data));

        // Lógica robusta para pegar email em diferentes formatos de payload
        const email = data.email || data.client?.email || data.buyer_email || (data.data && data.data.buyer && data.data.buyer.email);
        const name = data.name || data.client?.name || data.buyer_name || (data.data && data.data.buyer && data.data.buyer.name);
        const status = data.status || data.transaction_status || data.event; 
        const productId = data.product_id || (data.data && data.data.product && data.data.product.id) || 'unknown';

        const invalidStatuses = ['refused', 'refunded', 'chargedback', 'canceled', 'dispute'];
        if (status && invalidStatuses.includes(status)) {
            return res.status(200).send("Status ignorado.");
        }

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
            } else {
                throw e;
            }
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

        if (isNewUser && passwordUsed) {
            await sendWelcomeEmail(email, passwordUsed);
        }

        return res.status(200).send("Sucesso.");

    } catch (error) {
        console.error("Erro Webhook:", error);
        return res.status(500).send("Erro: " + error.message);
    }
});

// ==================================================================
// 2. FUNÇÃO DELETAR (Gen 2)
// ==================================================================
exports.deleteStudent = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Faça login novamente.');
    }

    const data = request.data;
    const targetUid = data.uid;
    const appId = data.appId || DEFAULT_APP_ID;

    try {
        await admin.auth().deleteUser(targetUid);
        try {
            await db.collection("artifacts").doc(appId)
                .collection("public").doc("data")
                .collection("students").doc(targetUid).delete();
        } catch(e) { console.log("Doc já deletado ou inexistente."); }

        return { success: true, message: "Aluno deletado!" };
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
             await db.collection("artifacts").doc(appId)
                .collection("public").doc("data")
                .collection("students").doc(targetUid).delete();
             return { success: true, message: "Removido da lista (login não existia)." };
        }
        throw new HttpsError('internal', error.message);
    }
});

// ==================================================================
// 3. SINCRONIZAR OTIMIZADO (Resolve Erro INTERNAL)
// ==================================================================
exports.syncAuthToFirestore = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Faça login novamente.');
    }
    
    const appId = request.data.appId || DEFAULT_APP_ID;
    const studentsRef = db.collection("artifacts").doc(appId)
        .collection("public").doc("data").collection("students");

    // 1. Pega todos usuários do Auth (limite 1000 por vez)
    const listUsersResult = await admin.auth().listUsers(1000);
    const authUsers = listUsersResult.users;

    // 2. Pega APENAS os IDs que já existem no Firestore (Super Rápido)
    const snapshot = await studentsRef.select('uid').get();
    const existingIds = new Set(snapshot.docs.map(doc => doc.id));

    // 3. Filtra quem falta
    const missingUsers = authUsers.filter(u => 
        !existingIds.has(u.uid) && u.email !== 'admin@akko.com'
    );

    if (missingUsers.length === 0) {
        return { success: true, message: "Todos já estão sincronizados!" };
    }

    // 4. Grava em pacotes de 400 (Lote Seguro)
    const CHUNK_SIZE = 400;
    let savedCount = 0;

    for (let i = 0; i < missingUsers.length; i += CHUNK_SIZE) {
        const chunk = missingUsers.slice(i, i + CHUNK_SIZE);
        const batch = db.batch();

        chunk.forEach(user => {
            const docRef = studentsRef.doc(user.uid);
            batch.set(docRef, {
                uid: user.uid,
                email: user.email,
                name: user.displayName || "Usuario Importado",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                imported: true,
                accessLevel: 'student'
            });
        });

        await batch.commit();
        savedCount += chunk.length;
    }

    return { success: true, message: `${savedCount} usuários sincronizados!` };
});

// ==================================================================
// 4. RECUPERAÇÃO DE SENHA CUSTOMIZADA
// ==================================================================
exports.sendCustomRecoveryEmail = onCall(async (request) => {
    const email = request.data.email;
    if (!email) throw new HttpsError('invalid-argument', 'Email obrigatório.');

    try {
        const link = await admin.auth().generatePasswordResetLink(email);

        const htmlContent = `
            <div style="font-family: 'Arial', sans-serif; max-width: 600px; margin: 0 auto; background-color: #F8F9FD; border: 4px solid #2D2B38;">
                <div style="background-color: #F2E058; padding: 20px; text-align: center; border-bottom: 4px solid #2D2B38;">
                    <h1 style="margin: 0; color: #2D2B38; text-transform: uppercase;">Redefinir <span style="color: #6C5DD3;">Senha</span></h1>
                </div>
                <div style="padding: 30px; text-align: center; color: #2D2B38;">
                    <p style="font-size: 18px; margin-bottom: 30px;">Clique no botão abaixo para criar uma nova senha:</p>
                    <a href="${link}" style="background-color: #FF66C4; color: #fff; text-decoration: none; padding: 15px 30px; font-weight: bold; border: 3px solid #2D2B38; box-shadow: 4px 4px 0px #2D2B38; display: inline-block;">CRIAR NOVA SENHA</a>
                    <p style="margin-top: 30px; font-size: 12px; color: #666;">Se não pediu, ignore este email.</p>
                </div>
            </div>
        `;

        const mailOptions = {
            from: '"Akko Academy" <akkoacademycontato@gmail.com>',
            to: email,
            subject: '🔐 Redefinição de Senha',
            html: htmlContent
        };

        await transporter.sendMail(mailOptions);
        return { success: true };

    } catch (error) {
        if (error.code === 'auth/user-not-found') throw new HttpsError('not-found', 'Email não encontrado.');
        throw new HttpsError('internal', error.message);
    }
});

async function sendWelcomeEmail(email, password) {
    const mailOptions = {
        from: '"Akko Academy" <akkoacademycontato@gmail.com>',
        to: email,
        subject: '🚀 Acesso Liberado',
        html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; border: 2px solid #333; padding: 20px; border-radius: 10px;">
                <h2 style="color: #6C5DD3;">Bem-vindo à Akko Academy!</h2>
                <p>Seu acesso foi liberado.</p>
                <p><strong>Login:</strong> ${email}</p>
                <p><strong>Senha:</strong> ${password}</p>
                <a href="https://akko-academy.web.app/membros.html">ACESSAR AGORA</a>
            </div>
        `
    };
    try { await transporter.sendMail(mailOptions); } catch (e) { console.error(e); }
}