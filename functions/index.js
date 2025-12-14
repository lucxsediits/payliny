const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cors = require("cors")({ origin: true });

admin.initializeApp();
const db = admin.firestore();

const DEFAULT_APP_ID = '1:56272587692:web:6e62374b91269073784809';

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: "akkoacademycontato@gmail.com",
        pass: "fhhb efdx lzep jzvi",
    },
});

// WEBHOOK
exports.handleNewSale = functions.https.onRequest((req, res) => {
    return cors(req, res, async () => {
        try {
            // Log para debug
            console.log("Body recebido:", req.body);

            const data = req.body;
            // Lógica robusta para pegar email
            const email = data.email || data.client?.email || data.buyer_email || (data.data && data.data.buyer && data.data.buyer.email);
            const name = data.name || data.client?.name || data.buyer_name || (data.data && data.data.buyer && data.data.buyer.name);
            const status = data.status || data.transaction_status || data.event; 

            if (!email) {
                console.warn("Email não encontrado. Payload:", data);
                return res.status(200).send("Ignorado: Sem email.");
            }

            // Ignorar status de erro/reembolso
            const invalidStatuses = ['refused', 'refunded', 'chargedback', 'canceled'];
            if (status && invalidStatuses.includes(status)) {
                return res.status(200).send("Status ignorado.");
            }

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
                        displayName: name || "Novo Aluno"
                    });
                } else {
                    throw e;
                }
            }

            // Salva no Firestore
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
            console.error("Erro Webhook:", error);
            return res.status(500).send("Erro: " + error.message);
        }
    });
});

// DELETAR ALUNO
exports.deleteStudent = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');

    const targetUid = data.uid;
    const appId = data.appId || DEFAULT_APP_ID;

    try {
        await admin.auth().deleteUser(targetUid);
        await db.collection("artifacts").doc(appId)
            .collection("public").doc("data")
            .collection("students").doc(targetUid).delete();
        return { success: true };
    } catch (error) {
        if (error.code === 'auth/user-not-found') {
             // Se não existe no Auth, apaga só do banco
             await db.collection("artifacts").doc(appId)
                .collection("public").doc("data")
                .collection("students").doc(targetUid).delete();
             return { success: true };
        }
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// SINCRONIZAR
exports.syncAuthToFirestore = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Login necessário.');
    
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
    return { success: true, message: `${count} sincronizados.` };
});

async function sendWelcomeEmail(email, password) {
    const mailOptions = {
        from: '"Akko Academy" <akkoacademycontato@gmail.com>',
        to: email,
        subject: '🚀 Acesso Liberado',
        html: `Login: ${email}<br>Senha: ${password}`
    };
    try { await transporter.sendMail(mailOptions); } catch (e) { console.error(e); }
}