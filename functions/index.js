const { onCall, HttpsError, onRequest } = require("firebase-functions/v2/https");
const { onUserCreated } = require("firebase-functions/v2/identity");
const { setGlobalOptions } = require("firebase-functions/v2");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

admin.initializeApp();
const db = admin.firestore();

// Configurações Globais (Evita erros de memória/região)
setGlobalOptions({ maxInstances: 10, region: "us-central1" });

// SEU APP ID (Usado para garantir que gravamos no lugar certo)
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
// 1. WEBHOOK DE VENDAS (Hotmart/Cakto -> Cria Aluno + Email)
// ==================================================================
exports.handleNewSale = onRequest({ cors: true }, async (req, res) => {
    try {
        const data = req.body;
        
        // Normalização de dados (Cakto, Hotmart, Kiwify usam formatos diferentes)
        const email = data.email || data.client?.email || data.buyer_email;
        const name = data.name || data.client?.name || data.buyer_name;
        // Pega status ou assume aprovado se vier de evento específico
        const status = data.status || data.transaction_status || data.event; 

        console.log("Webhook recebido:", JSON.stringify(data));

        // Verificação básica de status
        // Se o status for explicitamente negado/refunded, ignoramos.
        // Se não tiver status claro mas tiver email, tentamos processar (útil para testes)
        const invalidStatuses = ['refused', 'refunded', 'chargedback', 'canceled'];
        if (status && invalidStatuses.includes(status)) {
            return res.status(200).send("Status não é de aprovação. Ignorado.");
        }

        if (!email) return res.status(400).send("Email não encontrado no payload.");

        console.log(`⚡ Processando venda para: ${email}`);

        // 1. Verifica ou Cria Auth
        let userRecord;
        let isNewUser = false;
        let passwordUsed = null;

        try {
            userRecord = await admin.auth().getUserByEmail(email);
            console.log("Usuário já existe no Auth. Liberando acesso...");
        } catch (e) {
            if (e.code === 'auth/user-not-found') {
                isNewUser = true;
                // Gera senha aleatória
                passwordUsed = Math.random().toString(36).slice(-8) + "Aa1";
                
                userRecord = await admin.auth().createUser({
                    email: email,
                    password: passwordUsed,
                    displayName: name
                });
                console.log("Novo usuário criado no Auth!");
            } else {
                throw e;
            }
        }

        // 2. Salvar no Firestore (Garante que apareça na lista de alunos)
        // Usamos set com merge para não apagar dados se já existirem
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

        // 3. Enviar Email (Apenas se for novo usuário, para mandar a senha)
        if (isNewUser && passwordUsed) {
            await sendWelcomeEmail(email, passwordUsed);
        }

        return res.status(200).send("Aluno matriculado com sucesso.");

    } catch (error) {
        console.error("Erro no Webhook:", error);
        return res.status(500).send("Erro interno: " + error.message);
    }
});

// ==================================================================
// 2. FUNÇÃO DELETAR (Chamada pelo Painel Admin)
// ==================================================================
exports.deleteStudent = onCall(async (request) => {
    // Segurança: Apenas quem está logado pode chamar
    if (!request.auth) {
        throw new HttpsError('unauthenticated', 'Precisa estar logado.');
    }

    const targetUid = request.data.uid;
    const appId = request.data.appId || DEFAULT_APP_ID;

    try {
        // 1. Deleta do Auth (Login)
        await admin.auth().deleteUser(targetUid);
        
        // 2. Deleta do Firestore (Lista)
        await db.collection("artifacts").doc(appId)
            .collection("public").doc("data")
            .collection("students").doc(targetUid).delete();

        return { success: true, message: "Aluno deletado de tudo!" };
    } catch (error) {
        console.error("Erro ao deletar:", error);
        
        // Se o usuário não existe no Auth (já foi deletado manualmente), deleta só do banco
        if (error.code === 'auth/user-not-found') {
             await db.collection("artifacts").doc(appId)
                .collection("public").doc("data")
                .collection("students").doc(targetUid).delete();
             return { success: true, message: "Login não existia, mas removido da lista." };
        }
        throw new HttpsError('internal', error.message);
    }
});

// ==================================================================
// 3. SINCRONIZAR (Importar Auth -> Firestore)
// ==================================================================
exports.syncAuthToFirestore = onCall(async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Logue como admin.');
    
    const appId = request.data.appId || DEFAULT_APP_ID;
    const collectionRef = db.collection("artifacts").doc(appId)
        .collection("public").doc("data").collection("students");

    // Pega os últimos 1000 usuários cadastrados no Authentication
    const listUsersResult = await admin.auth().listUsers(1000);
    const batch = db.batch();
    let count = 0;

    for (const user of listUsersResult.users) {
        // Verifica se o documento já existe no banco
        const docRef = collectionRef.doc(user.uid);
        const docSnap = await docRef.get();

        if (!docSnap.exists) {
            // Se não existe, cria o registro
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

    // Executa todas as gravações de uma vez
    if (count > 0) await batch.commit();
    
    return { 
        success: true, 
        message: count === 0 ? "Tudo já estava sincronizado!" : `${count} usuários recuperados!` 
    };
});

// ==================================================================
// 4. GATILHO AUTOMÁTICO (Backup)
// ==================================================================
// Dispara sempre que um usuário é criado no Auth (seja por webhook ou console)
exports.onUserCreatedTrigger = onUserCreated(async (event) => {
    const user = event.data;
    const appId = DEFAULT_APP_ID;

    const docRef = db.collection("artifacts").doc(appId)
        .collection("public").doc("data")
        .collection("students").doc(user.uid);

    const docSnap = await docRef.get();
    
    // IMPORTANTE: Só cria se NÃO existir. 
    // Isso evita que este trigger sobrescreva os dados completos que o Webhook já salvou.
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
// HELPER: ENVIO DE EMAIL
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
                    <p>Sua compra foi aprovada e seu acesso à plataforma já está liberado.</p>
                    
                    <div style="background: #f8f9fd; padding: 15px; border-left: 4px solid #6C5DD3; margin: 20px 0;">
                        <p style="margin: 5px 0;"><strong>📧 Login:</strong> ${email}</p>
                        <p style="margin: 5px 0;"><strong>🔑 Senha Provisória:</strong> ${password}</p>
                    </div>

                    <p style="text-align: center; margin-top: 30px;">
                        <a href="https://akko-academy.web.app" style="background-color: #6C5DD3; color: white; padding: 12px 24px; text-decoration: none; font-weight: bold; border-radius: 5px;">
                            ACESSAR PLATAFORMA AGORA
                        </a>
                    </p>
                </div>
                <div style="text-align: center; padding: 20px; font-size: 12px; color: #888;">
                    <p>Dica: Recomendamos trocar sua senha após o primeiro acesso.</p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log("Email enviado com sucesso para:", email);
    } catch (e) {
        console.error("Erro crítico ao enviar email:", e);
    }
}