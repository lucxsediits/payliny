const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cors = require("cors")({ origin: true });

admin.initializeApp();

// ==================================================================
// ⚙️ CONFIGURAÇÃO DE EMAIL (GMAIL)
// ==================================================================
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "akkoacademycontato@gmail.com",
    pass: "fhhb efdx lzep jzvi",
  },
});

// ==================================================================
// 🚀 WEBHOOK: RECEBER VENDA DA CAKTO
// ==================================================================
exports.handleNewSale = functions.https.onRequest(async (req, res) => {
  // 1. Permitir pedidos de qualquer origem (Cakto)
  cors(req, res, async () => {
    try {
      console.log("🔔 Webhook recebido. Payload:", JSON.stringify(req.body));

      // 2. Extrair dados (Compatível com Cakto e outros)
      // A Cakto costuma enviar os dados do cliente dentro de um objeto 'client' ou na raiz.
      const payload = req.body;
      
      const buyerEmail = 
        payload.client?.email || 
        payload.customer?.email || 
        payload.email;

      const buyerName = 
        payload.client?.name || 
        payload.customer?.name || 
        payload.name || 
        "Novo Aluno";

      // Validação de Segurança
      if (!buyerEmail) {
        console.error("❌ Email não encontrado no payload.");
        return res.status(400).send("Email obrigatório não encontrado.");
      }

      console.log(`✅ Processando venda para: ${buyerEmail}`);

      // 3. Gerar Senha Aleatória Segura
      const randomPassword = Math.random().toString(36).slice(-8) + "Aa1";

      // 4. Criar utilizador no Firebase Authentication
      let userRecord;
      try {
        userRecord = await admin.auth().createUser({
          email: buyerEmail,
          password: randomPassword,
          displayName: buyerName,
        });
        console.log("👤 Utilizador criado no Auth:", userRecord.uid);

        // (Opcional) Guardar dados extras no Firestore para o painel de admin
        await admin.firestore().collection('artifacts').doc('default-app-id').collection('public').doc('data').collection('students').add({
            uid: userRecord.uid,
            name: buyerName,
            email: buyerEmail,
            createdAt: admin.firestore.FieldValue.serverTimestamp()
        });

      } catch (err) {
        if (err.code === "auth/email-already-in-use") {
          console.log("⚠️ Utilizador já existe. Ignorando criação.");
          return res.status(200).send("Utilizador já existe.");
        }
        throw err;
      }

      // 5. Enviar Email com as Credenciais
      const mailOptions = {
        from: '"Akko Academy" <teu_email_suporte@gmail.com>',
        to: buyerEmail,
        subject: "🚀 Acesso Liberado: A tua jornada começa agora!",
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #2D2B38; max-width: 600px; margin: 0 auto; border: 3px solid #2D2B38; border-radius: 8px; overflow: hidden;">
            <div style="background-color: #F2E058; padding: 20px; text-align: center; border-bottom: 3px solid #2D2B38;">
              <h1 style="margin: 0; font-size: 24px;">BEM-VINDO À AKKO ACADEMY! ★</h1>
            </div>
            
            <div style="padding: 30px; background-color: #ffffff;">
              <p style="font-size: 16px;">Olá <strong>${buyerName}</strong>,</p>
              <p style="font-size: 16px;">A tua inscrição foi confirmada com sucesso. Já podes aceder à área de membros e começar a estudar.</p>
              
              <div style="background-color: #F8F9FD; border: 2px dashed #2D2B38; padding: 20px; border-radius: 8px; margin: 25px 0;">
                <p style="margin: 5px 0; font-size: 14px; color: #666;">O TEU LOGIN:</p>
                <p style="margin: 0 0 15px 0; font-size: 18px; font-weight: bold;">${buyerEmail}</p>
                
                <p style="margin: 5px 0; font-size: 14px; color: #666;">A TUA SENHA:</p>
                <p style="margin: 0; font-size: 18px; font-weight: bold; background: #fff; display: inline-block; padding: 5px 10px; border: 1px solid #ddd;">${randomPassword}</p>
              </div>

              <div style="text-align: center;">
                <a href="https://teu-projeto.web.app/membros.html" style="background-color: #FF66C4; color: #ffffff; text-decoration: none; padding: 15px 30px; font-weight: bold; border-radius: 50px; font-size: 16px; display: inline-block; border: 2px solid #2D2B38; box-shadow: 4px 4px 0 #2D2B38;">
                  ACEDER À PLATAFORMA ➔
                </a>
              </div>
            </div>
            
            <div style="background-color: #2D2B38; color: #ffffff; padding: 15px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">Se tiveres dúvidas, responde a este email.</p>
            </div>
          </div>
        `,
      };

      await transporter.sendMail(mailOptions);
      console.log("✉️ Email enviado com sucesso!");

      return res.status(200).send("Processado com sucesso.");

    } catch (error) {
      console.error("❌ Erro critico:", error);
      return res.status(500).send("Erro interno no servidor.");
    }
  });
});