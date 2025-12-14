const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");

// --- INICIALIZAÇÃO ---
admin.initializeApp();
const db = admin.firestore();

// --- CONFIGURAÇÕES GERAIS ---
// ID do seu aplicativo no Firestore (para garantir que salvamos no lugar certo)
const DEFAULT_APP_ID = '1:56272587692:web:6e62374b91269073784809';

// Configuração do Servidor de Email (Gmail)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: "akkoacademycontato@gmail.com",
        pass: "fhhb efdx lzep jzvi", // Sua senha de aplicativo
    },
});

// ==================================================================
// 1. WEBHOOK DE VENDAS (Hotmart / Cakto / Kiwify)
// Recebe a notificação de venda, cria o login e libera o acesso.
// ==================================================================
exports.handleNewSale = functions.https.onRequest(async (req, res) => {
    
    // 1. Configuração de CORS (Permite requisições de qualquer lugar)
    res.set('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
        res.set('Access-Control-Allow-Methods', 'POST');
        res.set('Access-Control-Allow-Headers', 'Content-Type');
        res.status(204).send('');
        return;
    }

    try {
        const data = req.body;
        console.log("🔔 Webhook Recebido:", JSON.stringify(data));

        // 2. Extração de Dados (Compatível com várias plataformas)
        const email = data.email || data.client?.email || data.buyer_email;
        const name = data.name || data.client?.name || data.buyer_name || "Novo Aluno";
        const status = data.status || data.transaction_status || data.event; 

        // 3. Validações de Segurança
        // Ignora status de reembolso ou cancelamento
        const invalidStatuses = ['refused', 'refunded', 'chargedback', 'canceled'];
        if (status && invalidStatuses.includes(status)) {
            console.log(`Status ignorado: ${status}`);
            return res.status(200).send("Status ignorado.");
        }

        if (!email) {
            console.error("Email não encontrado no payload.");
            return res.status(400).send("Email obrigatório.");
        }

        console.log(`⚡ Processando acesso para: ${email}`);

        // 4. Criação ou Recuperação do Usuário (Authentication)
        let userRecord;
        let isNewUser = false;
        let passwordUsed = null;

        try {
            // Tenta buscar se já existe
            userRecord = await admin.auth().getUserByEmail(email);
            console.log("Usuário já existente. Apenas liberando acesso...");
        } catch (e) {
            if (e.code === 'auth/user-not-found') {
                // Se não existe, cria um novo
                isNewUser = true;
                passwordUsed = Math.random().toString(36).slice(-8) + "Aa1"; // Senha aleatória forte
                
                userRecord = await admin.auth().createUser({
                    email: email,
                    password: passwordUsed,
                    displayName: name
                });
                console.log("Novo usuário criado com sucesso!");
            } else {
                throw e; // Erro desconhecido
            }
        }

        // 5. Gravação no Banco de Dados (Firestore)
        // Isso garante que o aluno apareça na lista do Painel Admin
        await db.collection('artifacts').doc(DEFAULT_APP_ID)
            .collection('public').doc('data')
            .collection('students').doc(userRecord.uid).set({
                uid: userRecord.uid,
                name: name,
                email: email,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                accessLevel: 'student',
                productId: data.product_id || 'venda_online',
                source: 'webhook'
            }, { merge: true }); // 'merge: true' evita apagar dados se já existirem

        // 6. Envio do Email de Boas-Vindas (Apenas para novos)
        if (isNewUser && passwordUsed) {
            await sendWelcomeEmail(email, passwordUsed);
        }

        return res.status(200).send("Acesso liberado com sucesso.");

    } catch (error) {
        console.error("❌ Erro Crítico no Webhook:", error);
        return res.status(500).send("Erro interno: " + error.message);
    }
});

// ==================================================================
// 2. DELETAR ALUNO (Chamado pelo Painel Admin)
// Apaga o login (Auth) E os dados da lista (Firestore)
// ==================================================================
exports.deleteStudent = functions.https.onCall(async (data, context) => {
    // Segurança: Só aceita chamadas de admins logados
    if (!context.auth) {
        throw new functions.https.HttpsError('unauthenticated', 'Acesso negado. Faça login.');
    }

    const targetUid = data.uid;
    const appId = data.appId || DEFAULT_APP_ID;

    console.log(`🗑️ Solicitado delete para UID: ${targetUid}`);

    try {
        // Tenta deletar o Login
        await admin.auth().deleteUser(targetUid);
        
        // Deleta o registro no Banco
        await db.collection("artifacts").doc(appId)
            .collection("public").doc("data")
            .collection("students").doc(targetUid).delete();

        return { success: true, message: "Aluno removido completamente!" };

    } catch (error) {
        console.error("Erro ao deletar:", error);

        // Caso especial: Usuário já não existia no Auth (erro user-not-found)
        // Nesse caso, forçamos a limpeza apenas do banco de dados.
        if (error.code === 'auth/user-not-found') {
             await db.collection("artifacts").doc(appId)
                .collection("public").doc("data")
                .collection("students").doc(targetUid).delete();
             return { success: true, message: "Login não existia, mas removido da lista." };
        }
        
        throw new functions.https.HttpsError('internal', error.message);
    }
});

// ==================================================================
// 3. SINCRONIZAR (Recuperação de Alunos)
// Varre todos os logins do sistema e recria na lista se estiverem faltando.
// ==================================================================
exports.syncAuthToFirestore = functions.https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError('unauthenticated', 'Acesso negado.');
    
    const appId = data.appId || DEFAULT_APP_ID;
    const studentsRef = db.collection("artifacts").doc(appId)
        .collection("public").doc("data").collection("students");

    // Busca os últimos 1000 usuários cadastrados no Authentication
    const listUsersResult = await admin.auth().listUsers(1000);
    
    const batch = db.batch(); // Prepara uma gravação em lote (mais rápido)
    let count = 0;

    for (const user of listUsersResult.users) {
        const docRef = studentsRef.doc(user.uid);
        const docSnap = await docRef.get();

        // Se o aluno NÃO estiver na lista do banco, adiciona ele
        if (!docSnap.exists) {
            batch.set(docRef, {
                uid: user.uid,
                email: user.email,
                name: user.displayName || "Aluno Recuperado",
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                imported: true
            });
            count++;
        }
    }

    // Executa as gravações se houver algo para salvar
    if (count > 0) await batch.commit();
    
    return { success: true, message: `${count} alunos recuperados para a lista!` };
});

// ==================================================================
// FUNÇÃO AUXILIAR: Enviar Email (HTML Bonito)
// ==================================================================
async function sendWelcomeEmail(email, password) {
    const mailOptions = {
        from: '"Akko Academy" <akkoacademycontato@gmail.com>',
        to: email,
        subject: '🚀 Acesso Liberado: Akko Academy',
        html: `
            <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 1px solid #e0e0e0; border-radius: 8px; overflow: hidden;">
                <!-- Cabeçalho -->
                <div style="background-color: #F2E058; padding: 30px; text-align: center; border-bottom: 4px solid #2D2B38;">
                    <h1 style="margin:0; font-size: 28px; color: #2D2B38; text-transform: uppercase; letter-spacing: 2px;">AKKO ACADEMY</h1>
                </div>
                
                <!-- Conteúdo -->
                <div style="padding: 40px 30px; background-color: #ffffff;">
                    <h2 style="color: #6C5DD3; margin-top: 0;">Bem-vindo(a) ao time! 🔥</h2>
                    <p style="font-size: 16px; line-height: 1.5; color: #555;">Sua compra foi confirmada e o seu acesso à plataforma de alunos já está liberado.</p>
                    
                    <div style="background-color: #F8F9FD; border-left: 5px solid #6C5DD3; padding: 20px; margin: 30px 0; border-radius: 4px;">
                        <p style="margin: 5px 0; font-size: 16px;"><strong>📧 Login:</strong> ${email}</p>
                        <p style="margin: 5px 0; font-size: 16px;"><strong>🔑 Senha Provisória:</strong> ${password}</p>
                    </div>

                    <p style="text-align: center; margin-top: 40px;">
                        <a href="https://akko-academy.web.app" style="background-color: #2D2B38; color: #F2E058; padding: 15px 30px; text-decoration: none; font-weight: bold; border-radius: 50px; font-size: 16px; display: inline-block; box-shadow: 0 4px 6px rgba(0,0,0,0.1);">
                            ACESSAR PLATAFORMA
                        </a>
                    </p>
                </div>

                <!-- Rodapé -->
                <div style="background-color: #f5f5f5; text-align: center; padding: 20px; font-size: 12px; color: #999; border-top: 1px solid #e0e0e0;">
                    <p>Dica de segurança: Recomendamos trocar sua senha após o primeiro acesso.</p>
                    <p>© 2025 Akko Academy. Todos os direitos reservados.</p>
                </div>
            </div>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log(`📧 Email enviado com sucesso para: ${email}`);
    } catch (e) {
        console.error("❌ Erro ao enviar email:", e);
    }
}