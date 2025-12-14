/**
 * Import function triggers from their respective submodules:
 *
 * const {onCall} = require("firebase-functions/v2/https");
 * const {onDocumentWritten} = require("firebase-functions/v2/firestore");
 *
 * See a full list of supported triggers at https://firebase.google.com/docs/functions
 */

// IMPORTANTE: Imports da V2 (Geração 2)
const { onRequest, onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

// Inicializa o Admin SDK
admin.initializeApp();
const db = admin.firestore();

// Configurações Globais da Gen 2 (Resolve o erro de CPU/Região)
setGlobalOptions({ 
    maxInstances: 10,
    region: 'us-central1' // Região padrão, mude se necessário
});

// SEU APP ID
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
// 1. WEBHOOK DE VENDAS (MIGRADO PARA GEN 2)
// ==================================================================
// A opção { cors: true } resolve problemas de Cross-Origin automaticamente
exports.handleNewSale = onRequest({ cors: true }, async (req, res) => {
    try {
        const data = req.body;
        console.log("Webhook Recebido (Gen 2):", JSON.stringify(data));

        // Estratégia robusta para pegar dados (Hotmart/Cakto/Outros)
        const email = data.email || data.client?.email || data.buyer_email || (data.data && data.data.buyer && data.data.buyer.email);
        const name = data.name || data.client?.name || data.buyer_name || (data.data && data.data.buyer && data.data.buyer.name);
        const status = data.status || data.transaction_status || data.event; 
        const productId = data.product_id || (data.data && data.data.product && data.data.product.id) || 'unknown';

        // Filtra status indesejados
        const invalidStatuses = ['refused', 'refunded', 'chargedback', 'canceled', 'dispute'];
        if (status && invalidStatuses.includes(status)) {
            return res.status(200).send("Status ignorado.");
        }

        if (!email) {
            console.warn("Email não encontrado no payload.");
            return res.status(400).send("Email não encontrado.");
        }

        let userRecord;
        let isNewUser = false;
        let passwordUsed = null;

        // 1. Tenta encontrar ou criar usuário no Auth
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

        // 2. Salva/Atualiza no Firestore (Banco de Dados)
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

        // 3. Envia Email se for novo usuário
        if (isNewUser && passwordUsed) {
            await sendWelcomeEmail(email, passwordUsed);
        }

        return res.status(200).send("Sucesso.");

    } catch (error) {
        console.error("Erro Crítico no Webhook:", error);
        return res.status(500).send("Erro interno: " + error.message);
    }
});

// ==================================================================
// 2. FUNÇÃO DELETAR (MIGRADO PARA GEN 2)
// ==================================================================
exports.deleteStudent = onCall(async (request) => {
    // Na Gen 2, 'context' vira 'request' e os dados ficam em 'request.data'
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Faça login novamente.');
    }

    const data = request.data;
    const targetUid = data.uid;
    const appId = data.appId || DEFAULT_APP_ID;

    try {
        await admin.auth().deleteUser(targetUid);
        // Tenta limpar do banco também
        try {
            await db.collection("artifacts").doc(appId)
                .collection("public").doc("data")
                .collection("students").doc(targetUid).delete();
        } catch(e) { 
            console.log("Aviso: Documento já deletado ou inexistente."); 
        }

        return { success: true, message: "Aluno deletado!" };
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
             // Se não existe no Auth, força limpeza do banco
             await db.collection("artifacts").doc(appId)
                .collection("public").doc("data")
                .collection("students").doc(targetUid).delete();
             return { success: true, message: "Removido da lista (login não existia)." };
        }
        throw new HttpsError('internal', error.message);
    }
});

// ==================================================================
// 3. SINCRONIZAR (MIGRADO PARA GEN 2)
// ==================================================================
exports.syncAuthToFirestore = onCall(async (request) => {
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Faça login novamente.');
    }
    
    const data = request.data;
    const appId = data.appId || DEFAULT_APP_ID;
    const collectionRef = db.collection("artifacts").doc(appId)
        .collection("public").doc("data").collection("students");

    const listUsersResult = await admin.auth().listUsers(1000);
    const batch = db.batch();
    let count = 0;

    for (const user of listUsersResult.users) {
        // Ignora o admin para não misturar na lista de alunos
        if (user.email === 'admin@akko.com') continue;

        const docRef = collectionRef.doc(user.uid);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            batch.set(docRef, {
                uid: user.uid,
                email: user.email,
                name: user.displayName || "Usuario Importado",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                imported: true,
                accessLevel: 'student'
            });
            count++;
        }
    }

    if (count > 0) await batch.commit();
    return { success: true, message: `${count} usuários sincronizados!` };
});

async function sendWelcomeEmail(email, password) {
    const mailOptions = {
        from: '"Akko Academy" <akkoacademycontato@gmail.com>',
        to: email,
        subject: '🚀 Acesso Liberado - Akko Academy',
        html: `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px;">
                <h2 style="color: #6C5DD3;">Bem-vindo à Akko Academy!</h2>
                <p>Seu pagamento foi confirmado e seu acesso já está liberado.</p>
                <div style="background: #F8F9FD; padding: 20px; border-radius: 8px; border: 2px solid #2D2B38; display: inline-block; margin: 10px 0;">
                    <p style="margin: 0; font-weight: bold;">Login:</p>
                    <p style="margin: 0 0 10px 0;">${email}</p>
                    <p style="margin: 0; font-weight: bold;">Senha:</p>
                    <p style="margin: 0;">${password}</p>
                </div>
                <p>Acesse a área de membros:</p>
                <a href="https://akko-academy.web.app/membros.html" style="background-color: #FF66C4; color: white; padding: 10px 20px; text-decoration: none; border-radius: 5px; font-weight: bold;">ACESSAR AGORA</a>
                <p style="font-size: 12px; color: #888; margin-top: 30px;">Se tiver dúvidas, responda a este e-mail.</p>
            </div>
        `
    };
    try { await transporter.sendMail(mailOptions); } catch (e) { console.error("Erro ao enviar email:", e); }
}