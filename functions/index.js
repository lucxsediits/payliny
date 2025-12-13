const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cors = require("cors")({ origin: true });

admin.initializeApp();

// 1. Configuração do Email (SMTP)
// Para Gmail, precisas de gerar uma "Senha de App" nas definições da conta Google.
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "akkoacademycontato@gmail.com", // ⚠️ COLOCA O TEU EMAIL
    pass: "fhhb efdx lzep jzvi",       // ⚠️ COLOCA A SENHA DE APP (Não a senha normal)
  },
});

// 2. Função que recebe o Webhook da Cakto
exports.handleNewSale = functions.https.onRequest(async (req, res) => {
  // Permite que qualquer origem chame (CORS)
  cors(req, res, async () => {
    try {
      console.log("Payload recebido da Cakto:", JSON.stringify(req.body));

      // Extração de dados (Adaptação para Cakto e formatos comuns)
      // A Cakto geralmente envia dentro de 'customer' ou 'client'
      const payload = req.body;
      
      const buyerEmail = 
        payload.customer?.email || 
        payload.client?.email || 
        payload.email || 
        payload.data?.buyer?.email; // Fallback para outros formatos

      const buyerName = 
        payload.customer?.name || 
        payload.client?.name || 
        payload.name || 
        payload.data?.buyer?.name || 
        "Aluno";

      if (!buyerEmail) {
        console.error("Email não encontrado no payload.");
        return res.status(400).send("Email não encontrado.");
      }

      console.log(`Nova venda Cakto recebida para: ${buyerEmail}`);

      // 3. Gerar Senha Aleatória
      const randomPassword = Math.random().toString(36).slice(-8) + "Aa1";

      // 4. Criar utilizador no Firebase Auth
      let userRecord;
      try {
        userRecord = await admin.auth().createUser({
          email: buyerEmail,
          password: randomPassword,
          displayName: buyerName,
        });
        console.log("Utilizador criado:", userRecord.uid);
      } catch (err) {
        if (err.code === "auth/email-already-in-use") {
          console.log("Utilizador já existe. Apenas reenvio de email (opcional).");
          // Podes optar por não fazer nada ou enviar email de recuperação
          return res.status(200).send("Utilizador já existe.");
        }
        throw err;
      }

      // 5. Enviar Email com Credenciais
      const mailOptions = {
        from: '"Akko Academy" <teu_email_suporte@gmail.com>',
        to: buyerEmail,
        subject: "🚀 Acesso Liberado: Akko Academy",
        html: `
          <div style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; border: 2px solid #2D2B38; padding: 20px; border-radius: 10px;">
            <h1 style="color: #FF66C4;">Bem-vindo(a), ${buyerName}!</h1>
            <p>A tua compra na Cakto foi confirmada e o teu acesso já está criado.</p>
            
            <div style="background-color: #F8F9FD; padding: 15px; border-radius: 5px; border: 1px dashed #2D2B38; margin: 20px 0;">
              <p style="margin: 5px 0;"><strong>Login:</strong> ${buyerEmail}</p>
              <p style="margin: 5px 0;"><strong>Senha Provisória:</strong> ${randomPassword}</p>
            </div>

            <p>Acede agora à plataforma:</p>
            <a href="[https://teu-site-akko.web.app](https://teu-site-akko.web.app)" style="background-color: #F2E058; color: #2D2B38; padding: 10px 20px; text-decoration: none; font-weight: bold; border: 2px solid #2D2B38; border-radius: 5px; display: inline-block;">ACESSAR ÁREA DE MEMBROS</a>
            
            <p style="font-size: 12px; color: #666; margin-top: 30px;">Se tiveres dúvidas, responde a este email.</p>
          </div>
        `,
      };

      await transporter.sendMail(mailOptions);
      console.log("Email enviado com sucesso!");

      return res.status(200).send("Processado com sucesso.");

    } catch (error) {
      console.error("Erro critico:", error);
      return res.status(500).send("Erro interno no servidor.");
    }
  });
});