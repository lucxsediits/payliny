import { initializeApp } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/11.6.1/firebase-firestore.js";

// =========================================================================
// ⚙️ SUAS CONFIGURAÇÕES DO FIREBASE
// =========================================================================
// Para produção, substitua pelo objeto do seu console.
// Mantive a lógica dinâmica para compatibilidade com o ambiente de testes.
const firebaseConfig = typeof __firebase_config !== 'undefined' 
    ? JSON.parse(__firebase_config) 
    : JSON.parse(new URLSearchParams(window.location.search).get('firebase_config') || '{}');

const appId = typeof __app_id !== 'undefined' ? __app_id : 'default-app-id';

// Inicialização
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// Exportando para usar em outros arquivos
export { app, auth, db, appId };





const manualConfig = {
    apiKey: "AIzaSyAr13YDQhGCvsbuWp3RpPH0jzpm5_MyHww",
    authDomain: "akko-academy.firebaseapp.com",
    projectId: "akko-academy",
    storageBucket: "akko-academy.firebasestorage.app",
    messagingSenderId: "56272587692",
    appId: "1:56272587692:web:6e62374b91269073784809"
};