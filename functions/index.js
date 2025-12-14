const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

// SEU APP ID
const DEFAULT_APP_ID = '1:56272587692:web:6e62374b91269073784809';

// Configuração de Email (Nodemailer)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: "akkoacademycontato@gmail.com",
        pass: "fhhb efdx lzep jzvi",
    },
});

// ==================================================================
// 1. WEBHOOK DE VENDAS (Compatível V1)
// ==================================================================
exports.handleNewSale = functions.https.onRequest(async (req, res) => {
    // Habilitar CORS manualmente para garantir que funcione em qualquer lugar
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.status(204).send('');
        return;
    }

    try {
        const data = req.body;
        const email = data.email || data.client?.email || data.buyer_email;
        const name = data.name || data.client?.name || data.buyer_name;
        const status = data.status || data.transaction_status || data.event; 

        console.log("Webhook recebido:", JSON.stringify(data));

        const invalidStatuses = ['refused', 'refunded', 'chargedback', 'canceled'];
        if (status && invalidStatuses.includes(status)) {
            return res.status(200).send("Status não aprovado.");
        }

        if (!email) return res.status(400).send("Email não encontrado.");

        console.log(`⚡ Processando venda para: ${email}`);

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
                    displayName: name
                });
            } else {
                throw e;
            }
        }

        await db.collection('artifacts').doc(DEFAULT_APP_ID)
            .collection('public').doc('data')
            .collection('students').doc(userRecord.uid).set({
                uid: userRecord.uid,
                name: name || userRecord.displayName || 'Aluno Novo',
                email: email,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                accessLevel: 'student',
                productId: data.product_id || 'unknown'
            }, { merge: true });

        if (isNewUser && passwordUsed) {
            await sendWelcomeEmail(email, passwordUsed);
        }

        return res.status(200).send("Sucesso.");

    } catch (error) {
        console.error("Erro no Webhook:", error);
        return res.status(500).send("Erro: " + error.message);
    }
});

// ==================================================================
// 2. FUNÇÃO DELETAR (Compatível V1)
// ==================================================================
exports.deleteStudent = functions.https.onCall(async (data, context) => {
    // Em V1, 'data' são os dados enviados e 'context' tem a autenticação
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Precisa estar logado.');
    }

    const targetUid = data.uid;
    const appId = data.appId || DEFAULT_APP_ID;

    try {
        await admin.auth().deleteUser(targetUid);
        
        await db.collection("artifacts").doc(appId)
            .collection("public").doc("data")
            .collection("students").doc(targetUid).delete();

        return { success: true, message: "Aluno deletado!" };
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
             await db.collection("artifacts").doc(appId)
                .collection("public").doc("data")
                .collection("students").doc(targetUid).delete();
             return { success: true, message: "Apenas removido da lista (login não existia)." };
        }
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// ==================================================================
// 3. SINCRONIZAR (Compatível V1)
// ==================================================================
exports.syncAuthToFirestore = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Logue como admin.');
    
    const appId = data.appId || DEFAULT_APP_ID;
    const collectionRef = db.collection("artifacts").doc(appId)
        .collection("public").doc("data").collection("students");

    const listUsersResult = await admin.auth().listUsers(1000);
    const batch = db.batch();
    let count = 0;

    for (const user of listUsersResult.users) {
        const docRef = collectionRef.doc(user.uid);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            batch.set(docRef, {
                uid: user.uid,
                email: user.email,
                name: user.displayName || "Usuario Importado",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                imported: true
            });
            count++;
        }
    }

    if (count > 0) await batch.commit();
    return { success: true, message: `${count} usuários sincronizados!` };
});

// ==================================================================
// 4. GATILHO AUTOMÁTICO (Compatível V1)
// ==================================================================
exports.onUserCreatedTrigger = functions.auth.user().onCreate(async (user) => {
    const appId = DEFAULT_APP_ID;
    const docRef = db.collection("artifacts").doc(appId)
        .collection("public").doc("data")
        .collection("students").doc(user.uid);

    const docSnap = await docRef.get();
    
    if (!docSnap.exists) {
        await docRef.set({
            uid: user.uid,
            email: user.email,
            name: user.displayName || "Novo Aluno (Via Console)",
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
    }
});

// ==================================================================
// HELPER: EMAIL
// ==================================================================
async function sendWelcomeEmail(email, password) {
    const mailOptions = {
        from: '"Akko Academy" <akkoacademycontato@gmail.com>',
        to: email,
        subject: '🚀 Acesso Liberado: Akko Academy',
        html: `
            <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto;">
                <div style="background-color: #F2E058; padding: 20px; text-align: center; border-bottom: 4px solid #2D2B38;">
                    <h1 style="margin:0; font-family: 'Arial Black', sans-serif; color: #2D2B38;">AKKO ACADEMY</h1>
                </div>
                <div style="padding: 20px; background-color: #fff; border: 1px solid #ddd;">
                    <h2>Bem-vindo(a) ao time! 🔥</h2>
                    <p>Login: <strong>${email}</strong></p>
                    <p>Senha: <strong>${password}</strong></p>
                    <p><a href="https://akko-academy.web.app">ACESSAR AGORA</a></p>
                </div>
            </div>
        `
    };
    try { await transporter.sendMail(mailOptions); } catch (e) { console.error(e); }
}