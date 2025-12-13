const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer"); // Para enviar emails (opcional)

admin.initializeApp();
const db = admin.firestore();

// --- CONFIGURAÇÃO DO EMAIL (Opcional) ---
// Use um email Gmail real ou serviço como SendGrid
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: "akkoacademycontato@gmail.com", // ⚠️ COLOCA O TEU EMAIL
      pass: "fhhb efdx lzep jzvi",       // ⚠️ COLOCA A SENHA DE APP (Não a senha normal)
    },
});

/**
 * 🔗 WEBHOOK: Recebe a venda da Hotmart/Cakto/Kiwify
 * URL para configurar na plataforma: https://us-central1-SEU-PROJETO.cloudfunctions.net/handleNewSale
 */
exports.handleNewSale = functions.https.onRequest(async (req, res) => {
    try {
        // As plataformas enviam dados de formas diferentes. 
        // Adapte conforme a documentação da Hotmart/Cakto.
        // Exemplo genérico:
        const data = req.body;
        
        // Dados do Comprador
        const email = data.email || data.client?.email || data.buyer_email;
        const name = data.name || data.client?.name || data.buyer_name;
        const status = data.status || data.transaction_status; // Ex: 'approved', 'paid'

        // Verifica se foi aprovado
        if (status !== 'approved' && status !== 'paid' && status !== 'COMPLETED') {
            return res.status(200).send("Status não é de aprovação. Ignorado.");
        }

        if (!email) return res.status(400).send("Email não encontrado no payload.");

        console.log(`⚡ Nova venda aprovada para: ${email}`);

        // 1. Verifica se usuário já existe no Auth
        let userRecord;
        try {
            userRecord = await admin.auth().getUserByEmail(email);
            console.log("Usuário já existe, liberando acesso...");
        } catch (e) {
            // 2. Se não existe, cria um novo
            const tempPassword = Math.random().toString(36).slice(-8) + "Aa1";
            userRecord = await admin.auth().createUser({
                email: email,
                password: tempPassword,
                displayName: name
            });
            console.log("Novo usuário criado!");

            // 3. Enviar Email de Boas-vindas (Lógica Simples)
            await sendWelcomeEmail(email, tempPassword);
        }

        // 4. Salvar/Atualizar no Firestore (Para aparecer na lista de alunos e liberar acesso)
        await db.collection('artifacts').doc('1:56272587692:web:6e62374b91269073784809') // Seu App ID
            .collection('public').doc('data')
            .collection('students').doc(userRecord.uid).set({
                uid: userRecord.uid,
                name: name || 'Aluno Novo',
                email: email,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                accessLevel: 'student', // Pode usar isso para regras de segurança
                productId: data.product_id // Guarda qual curso comprou
            }, { merge: true });

        return res.status(200).send("Aluno matriculado com sucesso.");

    } catch (error) {
        console.error("Erro no Webhook:", error);
        return res.status(500).send("Erro interno: " + error.message);
    }
});

// Função Auxiliar de Email
async function sendWelcomeEmail(email, password) {
    const mailOptions = {
        from: '"Akko Academy" <seu.email@gmail.com>',
        to: email,
        subject: '🚀 Acesso Liberado: Akko Academy',
        html: `
            <h1>Bem-vindo(a) à Akko Academy!</h1>
            <p>Sua compra foi aprovada e seu acesso está liberado.</p>
            <p><strong>Link:</strong> <a href="https://akko-academy.web.app">Acessar Plataforma</a></p>
            <p><strong>Login:</strong> ${email}</p>
            <p><strong>Senha Provisória:</strong> ${password}</p>
            <hr>
            <p>Dica: Troque sua senha após o primeiro acesso.</p>
        `
    };

    try {
        await transporter.sendMail(mailOptions);
        console.log("Email enviado para:", email);
    } catch (e) {
        console.error("Erro ao enviar email:", e);
    }
}