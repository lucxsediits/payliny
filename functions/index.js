const functions = require("firebase-functions");
const admin = require("firebase-admin");
const nodemailer = require("nodemailer");
const cors = require("cors")({ origin: true });

admin.initializeApp();

// ⚙️ CONFIG DO EMAIL (MANTÉM OS TEUS DADOS AQUI)
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: "akkoacademycontato@gmail.com",
    pass: "fhhb efdx lzep jzvi",    
  },
});

// 1. WEBHOOK DE VENDAS (Cakto/Hotmart)
exports.handleNewSale = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const payload = req.body;
      const email = payload.client?.email || payload.customer?.email || payload.email;
      const name = payload.client?.name || payload.customer?.name || payload.name || "Aluno";

      if (!email) return res.status(400).send("Email não encontrado.");

      const password = Math.random().toString(36).slice(-8) + "Aa1";

      try {
        await admin.auth().createUser({ email, password, displayName: name });
      } catch (err) {
        if (err.code === "auth/email-already-in-use") return res.status(200).send("Usuário já existe.");
        throw err;
      }

      // Envia Email (PT-BR)
      await transporter.sendMail({
        from: '"Akko Academy" <teu_email@gmail.com>',
        to: email,
        subject: "🚀 Acesso Liberado: Sua jornada começa agora!",
        html: `
          <div style="font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; color: #2D2B38; max-width: 600px; margin: 0 auto; border: 3px solid #2D2B38; border-radius: 8px; overflow: hidden;">
            <div style="background-color: #F2E058; padding: 20px; text-align: center; border-bottom: 3px solid #2D2B38;">
              <h1 style="margin: 0; font-size: 24px;">BEM-VINDO À AKKO ACADEMY! ★</h1>
            </div>
            
            <div style="padding: 30px; background-color: #ffffff;">
              <p style="font-size: 16px;">Olá <strong>${name}</strong>,</p>
              <p style="font-size: 16px;">Sua inscrição foi confirmada com sucesso. Já pode acessar a área de membros e começar a estudar.</p>
              
              <div style="background-color: #F8F9FD; border: 2px dashed #2D2B38; padding: 20px; border-radius: 8px; margin: 25px 0;">
                <p style="margin: 5px 0; font-size: 14px; color: #666;">SEU LOGIN:</p>
                <p style="margin: 0 0 15px 0; font-size: 18px; font-weight: bold;">${email}</p>
                
                <p style="margin: 5px 0; font-size: 14px; color: #666;">SUA SENHA:</p>
                <p style="margin: 0; font-size: 18px; font-weight: bold; background: #fff; display: inline-block; padding: 5px 10px; border: 1px solid #ddd;">${password}</p>
              </div>

              <div style="text-align: center;">
                <a href="https://teu-projeto.web.app/membros.html" style="background-color: #FF66C4; color: #ffffff; text-decoration: none; padding: 15px 30px; font-weight: bold; border-radius: 50px; font-size: 16px; display: inline-block; border: 2px solid #2D2B38; box-shadow: 4px 4px 0 #2D2B38;">
                  ACESSAR PLATAFORMA ➔
                </a>
              </div>
            </div>
            
            <div style="background-color: #2D2B38; color: #ffffff; padding: 15px; text-align: center; font-size: 12px;">
              <p style="margin: 0;">Se tiver dúvidas, responda a este e-mail.</p>
            </div>
          </div>
        `
      });

      return res.status(200).send("Sucesso!");
    } catch (error) {
      console.error(error);
      return res.status(500).send("Erro interno.");
    }
  });
});

// 2. LISTAR TODOS OS USUÁRIOS (ADMIN API)
exports.listUsersAPI = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const listUsersResult = await admin.auth().listUsers(1000);
      const users = listUsersResult.users.map(user => ({
        uid: user.uid,
        email: user.email,
        displayName: user.displayName || 'Sem Nome',
        creationTime: user.metadata.creationTime,
        lastSignInTime: user.metadata.lastSignInTime
      }));
      res.json(users);
    } catch (error) {
      console.error(error);
      res.status(500).send('Erro ao listar.');
    }
  });
});

// 3. DELETAR USUÁRIO (ADMIN API)
exports.deleteUserAPI = functions.https.onRequest(async (req, res) => {
  cors(req, res, async () => {
    try {
      const uid = req.body.uid;
      if (!uid) return res.status(400).send("UID necessário.");
      
      await admin.auth().deleteUser(uid);
      res.json({ success: true });
    } catch (error) {
      console.error(error);
      res.status(500).send('Erro ao deletar.');
    }
  });
});