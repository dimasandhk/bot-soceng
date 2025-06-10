const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const { GoogleGenerativeAI } = require("@google/generative-ai");
const dotenv = require("dotenv");
dotenv.config(); // Memuat variabel lingkungan dari .env file jika ada

console.log("Memulai bot...");

// --- Initialize Gemini AI ---
// Make sure to set your GOOGLE_API_KEY environment variable
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY || "");
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-exp" });

console.log("Memulai bot...");

// --- Struktur Data Baru: Map ---
// Key: Nomor telepon ternormalisasi (string '628...'), Value: Object { nama: '...', nip: '...' }
let dosenDataMap = new Map();

// --- User Session Management ---
// Key: sender ID, Value: { step: 'menu'|'waiting_number'|'waiting_message'|'waiting_number_then_message', data: {} }
let userSessions = new Map();

// --- Fungsi Normalisasi (Sedikit Disesuaikan) ---
function normalizePhoneNumber(number) {
  if (!number || typeof number !== "string") return null; // Tambahan: Cek jika input valid
  // Hapus semua karakter non-digit (termasuk spasi, -, + di awal jika salah ketik)
  number = number.replace(/\D/g, "");
  if (number.startsWith("0")) {
    return "62" + number.substring(1);
  }
  // Jika sudah pakai 62 di depan (mungkin dari normalisasi sebelumnya atau input)
  if (number.startsWith("62")) {
    return number;
  }
  // Menangani kasus jika nomor dimulai langsung dengan 8 setelah menghapus 0 atau +62
  if (number.startsWith("8")) {
    return "62" + number;
  }
  // Jika format tidak dikenali setelah pembersihan
  console.warn(`Tidak dapat menormalisasi nomor: ${number}`);
  return null; // Kembalikan null jika tidak bisa dinormalisasi
}

// --- Fungsi Memuat Database (Disesuaikan untuk JSON Objek) ---
function loadDosenDatabase() {
  try {
    const filePath = "dosen.json"; // Nama file database Anda
    if (!fs.existsSync(filePath)) {
      console.error(
        `Error: File database ${filePath} tidak ditemukan! Bot mungkin tidak dapat memverifikasi nomor.`
      );
      dosenDataMap = new Map(); // Pastikan map kosong jika file tidak ada
      return;
    }
    const data = fs.readFileSync(filePath, "utf8");
    const dosenArray = JSON.parse(data); // Parsing array objek
    dosenDataMap = new Map(); // Kosongkan map sebelum mengisi ulang
    dosenArray.forEach((dosen) => {
      if (dosen && dosen.nama && dosen.nip && dosen.nomor_telepon) {
        // Pastikan semua field penting ada
        const normalizedNumber = normalizePhoneNumber(dosen.nomor_telepon);
        if (normalizedNumber) {
          // Simpan objek dengan nama dan nip, menggunakan nomor ternormalisasi sebagai key
          dosenDataMap.set(normalizedNumber, {
            nama: dosen.nama,
            nip: dosen.nip
          });
        } else {
          console.warn(
            `Nomor tidak valid atau tidak dapat dinormalisasi: ${dosen.nomor_telepon} untuk ${dosen.nama}`
          );
        }
      } else {
        console.warn(
          "Entri dosen tidak lengkap ditemukan dan dilewati:",
          dosen
        );
      }
    });
    console.log(`Database dosen dimuat: ${dosenDataMap.size} entri valid.`);
  } catch (err) {
    console.error("Gagal memuat atau memproses database dosen:", err);
    dosenDataMap = new Map(); // Pastikan map kosong jika ada error parsing/baca
  }
}

console.log("Menginisialisasi WhatsApp Client...");

const client = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: {
    // Opsi tambahan jika ada masalah Chromium/Puppeteer
    // executablePath: '/path/to/your/chrome/or/chromium', // Jika perlu menentukan path manual
    args: ["--no-sandbox", "--disable-setuid-sandbox"] // Umumnya aman & kadang dibutuhkan di Linux/Server
  }
  // Pengaturan sesi/waktu tunggu bisa ditambahkan di sini jika perlu
  // qrTimeout: 0, // Waktu tunggu QR tanpa batas
  // webVersionCache: {
  //   type: 'remote',
  //   remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.2412.54.html',
  // } // Contoh menggunakan versi WA Web spesifik jika ada masalah kompatibilitas
});

console.log("Client dibuat. Menunggu event...");

client.on("qr", (qr) => {
  console.log("QR Code diterima, pindai dengan WhatsApp Anda:");
  qrcode.generate(qr, { small: true });
});

client.on("ready", () => {
  console.log("-----------------------------------");
  console.log("       CLIENT WHATSAPP SIAP!       ");
  console.log("-----------------------------------");
  loadDosenDatabase(); // Muat database setelah client siap
});

client.on("authenticated", () => {
  console.log("Autentikasi Berhasil!");
});

client.on("auth_failure", (msg) => {
  console.error("-----------------------------------");
  console.error("     AUTENTIKASI GAGAL!            ");
  console.error("-----------------------------------");
  console.error("Pesan:", msg);
  console.error(
    "Kemungkinan penyebab: Sesi tidak valid, QR kedaluwarsa, masalah jaringan."
  );
  console.error(
    "Hapus folder .wwebjs_auth dan coba jalankan lagi untuk scan QR baru."
  );
});

client.on("disconnected", (reason) => {
  console.warn("-----------------------------------");
  console.warn("      CLIENT TERPUTUS!            ");
  console.warn("-----------------------------------");
  console.warn("Alasan:", reason);
  // Pertimbangkan untuk keluar dari proses atau mencoba inisialisasi ulang setelah jeda
  // client.initialize(); // Hati-hati dengan loop reconnect jika masalah persisten
  // process.exit(1); // Keluar jika terputus
});

// --- Memproses Pesan Masuk (Logika Baru dengan Menu) ---
client.on("message", async (msg) => {
  // Abaikan pesan dari status atau grup jika tidak diinginkan
  const chat = await msg.getChat();
  if (chat.isGroup || msg.isStatus) {
    console.log(`Pesan dari Grup/Status (${msg.from}), diabaikan.`);
    return;
  }

  const sender = msg.from; // Nomor pengirim (misal: 62812...@c.us)
  const messageBody = msg.body.trim();
  console.log(`[Pesan Masuk] Dari ${sender}: ${messageBody}`);

  // 1. Abaikan pesan dari diri sendiri (bot)
  if (msg.fromMe) {
    console.log("[Info] Pesan dari diri sendiri, diabaikan.");
    return; // Hentikan proses untuk pesan ini
  }

  // 2. Cek atau inisialisasi sesi user
  if (!userSessions.has(sender)) {
    userSessions.set(sender, { step: "menu", data: {} });
  }

  const userSession = userSessions.get(sender);

  // 3. Reset ke menu jika user mengetik "menu" atau "mulai"
  if (
    messageBody.toLowerCase() === "menu" ||
    messageBody.toLowerCase() === "mulai" ||
    messageBody.toLowerCase() === "start"
  ) {
    userSession.step = "menu";
    userSession.data = {};
  }

  // 4. Handle berdasarkan langkah sesi user
  if (userSession.step === "menu") {
    // Tampilkan menu pilihan
    const menuMessage =
      "🤖 *Selamat datang di Bot Verifikasi SOCENG*\n\nSilakan pilih opsi berikut dengan mengetik angka:\n\n*1* - Cek Nomor Dosen\n*2* - Cek Pesan (Analisis Spam/Scam)\n*3* - Cek Nomor + Analisis Pesan\n\nKetik angka pilihan Anda (1, 2, atau 3):";

    try {
      await client.sendMessage(sender, menuMessage);
      userSession.step = "waiting_menu_choice";
      console.log(`[Menu] Menu dikirim ke ${sender}`);
    } catch (error) {
      console.error(`[Error Menu] Gagal mengirim menu ke ${sender}:`, error);
    }
  } else if (userSession.step === "waiting_menu_choice") {
    // Handle pilihan menu
    const choice = messageBody.trim();

    if (choice === "1") {
      userSession.step = "waiting_number";
      const replyMsg =
        "📱 *Cek Nomor Dosen*\n\nSilakan kirim nomor telepon yang ingin Anda verifikasi:\n\nContoh: 081234567890";
      try {
        await client.sendMessage(sender, replyMsg);
        console.log(`[Menu] User ${sender} memilih cek nomor`);
      } catch (error) {
        console.error(
          `[Error] Gagal mengirim instruksi nomor ke ${sender}:`,
          error
        );
      }
    } else if (choice === "2") {
      userSession.step = "waiting_message";
      const replyMsg =
        "💬 *Analisis Pesan*\n\nSilakan kirim pesan yang ingin Anda analisis untuk mendeteksi spam/scam:\n\nContoh: Anda menang hadiah 1 miliar, klik link ini";
      try {
        await client.sendMessage(sender, replyMsg);
        console.log(`[Menu] User ${sender} memilih cek pesan`);
      } catch (error) {
        console.error(
          `[Error] Gagal mengirim instruksi pesan ke ${sender}:`,
          error
        );
      }
    } else if (choice === "3") {
      userSession.step = "waiting_number_then_message";
      const replyMsg =
        "📱💬 *Cek Nomor + Analisis Pesan*\n\nLangkah 1: Silakan kirim nomor telepon yang ingin Anda verifikasi:\n\nContoh: 081234567890";
      try {
        await client.sendMessage(sender, replyMsg);
        console.log(`[Menu] User ${sender} memilih cek nomor + pesan`);
      } catch (error) {
        console.error(
          `[Error] Gagal mengirim instruksi nomor+pesan ke ${sender}:`,
          error
        );
      }
    } else {
      // Pilihan tidak valid
      const errorMsg =
        "❌ *Pilihan Tidak Valid*\n\nSilakan ketik angka 1, 2, atau 3 sesuai menu yang tersedia.\n\nKetik 'menu' untuk melihat pilihan lagi.";
      try {
        await client.sendMessage(sender, errorMsg);
      } catch (error) {
        console.error(
          `[Error] Gagal mengirim pesan pilihan tidak valid ke ${sender}:`,
          error
        );
      }
    }
  } else if (userSession.step === "waiting_number") {
    // Handle input nomor telepon
    const numberToCheckRaw = messageBody;
    const normalizedNumber = normalizePhoneNumber(numberToCheckRaw);

    console.log(
      `[Proses] Cek nomor mentah: "${numberToCheckRaw}", dinormalisasi: "${normalizedNumber}"`
    );

    if (normalizedNumber) {
      // Cari di Map menggunakan nomor yang sudah dinormalisasi
      if (dosenDataMap.has(normalizedNumber)) {
        const dosenInfo = dosenDataMap.get(normalizedNumber);
        // Format balasan jika nomor DITEMUKAN
        const replyMsg = `✅ *Terverifikasi Dosen ITS*\n\nNomor *${numberToCheckRaw}* terdaftar atas nama:\n\n*Nama:* ${dosenInfo.nama}\n*NIP:* ${dosenInfo.nip}\n\n---\nKetik 'menu' untuk kembali ke menu utama.`;
        try {
          await client.sendMessage(sender, replyMsg);
          console.log(
            `[Respon Sukses] Respon Terverifikasi dikirim ke ${sender}`
          );
          // Reset session
          userSession.step = "menu";
          userSession.data = {};
        } catch (error) {
          console.error(
            `[Error Kirim] Gagal mengirim pesan Terverifikasi ke ${sender}:`,
            error
          );
        }
      } else {
        // Format balasan jika nomor TIDAK DITEMUKAN
        const replyMsg = `❌ *Tidak Terdaftar*\n\nNomor *${numberToCheckRaw}* tidak ditemukan dalam database dosen ITS kami.\n\n---\nKetik 'menu' untuk kembali ke menu utama.`;
        try {
          await client.sendMessage(sender, replyMsg);
          console.log(
            `[Respon Gagal] Respon Tidak Terdaftar dikirim ke ${sender}`
          );
          // Reset session
          userSession.step = "menu";
          userSession.data = {};
        } catch (error) {
          console.error(
            `[Error Kirim] Gagal mengirim pesan Tidak Terdaftar ke ${sender}:`,
            error
          );
        }
      }
    } else {
      // Jika nomor ada di perintah tapi GAGAL DINORMALISASI
      const replyMsg = `⚠️ *Format Nomor Salah*\n\nNomor "${numberToCheckRaw}" terlihat tidak valid. Pastikan Anda memasukkan nomor telepon yang benar (hanya angka, boleh ada spasi atau tanda hubung).\n\nSilakan coba lagi atau ketik 'menu' untuk kembali ke menu utama.`;
      try {
        await client.sendMessage(sender, replyMsg);
        console.log(
          `[Respon Error] Gagal memproses nomor: ${numberToCheckRaw} dari ${sender}`
        );
      } catch (error) {
        console.error(
          `[Error Kirim] Gagal mengirim pesan Format Nomor Salah ke ${sender}:`,
          error
        );
      }
    }
  } else if (userSession.step === "waiting_message") {
    // Handle input pesan untuk analisis
    const messageToCheck = messageBody;

    console.log(`[Proses] Analisis pesan: "${messageToCheck}"`);
    try {
      // Prompt khusus untuk analisis pesan saja (option 2)
      const prompt = `Analisis pesan berikut dan tentukan apakah ini merupakan pesan penipuan/scam/fraud/spam atau tidak. Berikan jawaban yang jelas dan alasan singkat dalam 1-2 kalimat.

Format jawaban: "Ya/Tidak, pesan ini [adalah/bukan] pesan penipuan karena [alasan singkat]."

Jangan gunakan emoji, bold text, atau bullet points. Jawab dalam paragraf biasa.

Pesan yang dianalisis: "${messageToCheck}"`;

      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();

      const replyMsg = `🤖 *Analisis Pesan SOCENG*\n\n${text}\n\n---\nKetik 'menu' untuk kembali ke menu utama.`;

      await client.sendMessage(sender, replyMsg);
      console.log(`[Respon AI] Analisis pesan dikirim ke ${sender}`);
      // Reset session
      userSession.step = "menu";
      userSession.data = {};
    } catch (error) {
      console.error(
        `[Error AI] Gagal menganalisis pesan dari ${sender}:`,
        error
      );
      const errorMsg = `❌ *Error*\n\nMaaf, terjadi kesalahan saat menganalisis pesan. Pastikan API key Google AI sudah dikonfigurasi dengan benar.\n\nKetik 'menu' untuk kembali ke menu utama.`;
      try {
        await client.sendMessage(sender, errorMsg);
        // Reset session
        userSession.step = "menu";
        userSession.data = {};
      } catch (sendError) {
        console.error(
          `[Error Kirim] Gagal mengirim pesan error ke ${sender}:`,
          sendError
        );
      }
    }
  } else if (userSession.step === "waiting_number_then_message") {
    if (!userSession.data.numberResult) {
      // Langkah 1: Proses nomor telepon
      const numberToCheckRaw = messageBody;
      const normalizedNumber = normalizePhoneNumber(numberToCheckRaw);

      console.log(
        `[Proses] Cek nomor (step 1): "${numberToCheckRaw}", dinormalisasi: "${normalizedNumber}"`
      );

      if (normalizedNumber) {
        let numberResult = "";
        if (dosenDataMap.has(normalizedNumber)) {
          const dosenInfo = dosenDataMap.get(normalizedNumber);
          numberResult = `✅ *Terverifikasi Dosen ITS*\n\nNomor *${numberToCheckRaw}* terdaftar atas nama:\n\n*Nama:* ${dosenInfo.nama}\n*NIP:* ${dosenInfo.nip}`;
        } else {
          numberResult = `❌ *Tidak Terdaftar*\n\nNomor *${numberToCheckRaw}* tidak ditemukan dalam database dosen ITS kami.`;
        }

        // Simpan hasil dan minta pesan
        userSession.data.numberResult = numberResult;
        const replyMsg = `${numberResult}\n\n---\n\n💬 *Langkah 2: Analisis Pesan*\n\nSekarang silakan kirim pesan yang ingin Anda analisis untuk mendeteksi spam/scam:`;

        try {
          await client.sendMessage(sender, replyMsg);
          console.log(
            `[Step 1] Hasil cek nomor dikirim, menunggu pesan dari ${sender}`
          );
        } catch (error) {
          console.error(
            `[Error] Gagal mengirim hasil step 1 ke ${sender}:`,
            error
          );
        }
      } else {
        const replyMsg = `⚠️ *Format Nomor Salah*\n\nNomor "${numberToCheckRaw}" terlihat tidak valid. Pastikan Anda memasukkan nomor telepon yang benar.\n\nSilakan coba lagi atau ketik 'menu' untuk kembali ke menu utama.`;
        try {
          await client.sendMessage(sender, replyMsg);
        } catch (error) {
          console.error(
            `[Error] Gagal mengirim pesan format nomor salah ke ${sender}:`,
            error
          );
        }
      }
    } else {
      // Langkah 2: Proses analisis pesan
      const messageToCheck = messageBody;

      console.log(`[Proses] Analisis pesan (step 2): "${messageToCheck}"`);
      try {
        // Tentukan status verifikasi nomor untuk konteks
        const isVerified = dosenDataMap.has(
          normalizePhoneNumber(
            userSession.data.numberResult.includes("Terverifikasi")
              ? "verified"
              : "not_verified"
          )
        );
        const phoneStatus = userSession.data.numberResult.includes("✅")
          ? "terverifikasi sebagai dosen ITS"
          : "tidak terdaftar dalam database dosen ITS";

        // Prompt khusus untuk analisis kombinasi nomor + pesan (option 3)
        const prompt = `Analisis pesan berikut dengan mempertimbangkan konteks nomor telepon pengirim.

KONTEKS NOMOR TELEPON:
Nomor telepon pengirim ${phoneStatus}.

TUGAS ANALISIS:
Tentukan apakah pesan ini merupakan penipuan/scam/fraud/spam dengan mempertimbangkan status verifikasi nomor telepon tersebut. Berikan analisis yang komprehensif namun ringkas.

Format jawaban: Mulai dengan "Ya/Tidak, pesan ini [adalah/bukan] pesan penipuan." kemudian jelaskan alasan dengan mempertimbangkan status nomor telepon.

Jangan gunakan emoji, bold text, atau bullet points. Jawab dalam paragraf biasa.

Pesan yang dianalisis: "${messageToCheck}"`;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();

        const replyMsg = `📱💬 *Hasil Lengkap Verifikasi*\n\n**HASIL CEK NOMOR:**\n${userSession.data.numberResult}\n\n**HASIL ANALISIS PESAN:**\n🤖 ${text}\n\n---\nKetik 'menu' untuk kembali ke menu utama.`;

        await client.sendMessage(sender, replyMsg);
        console.log(`[Step 2] Hasil lengkap dikirim ke ${sender}`);

        // Reset session
        userSession.step = "menu";
        userSession.data = {};
      } catch (error) {
        console.error(
          `[Error AI] Gagal menganalisis pesan step 2 dari ${sender}:`,
          error
        );
        const errorMsg = `❌ *Error*\n\nMaaf, terjadi kesalahan saat menganalisis pesan.\n\n**HASIL CEK NOMOR:**\n${userSession.data.numberResult}\n\nKetik 'menu' untuk kembali ke menu utama.`;
        try {
          await client.sendMessage(sender, errorMsg);
          // Reset session
          userSession.step = "menu";
          userSession.data = {};
        } catch (sendError) {
          console.error(
            `[Error Kirim] Gagal mengirim pesan error step 2 ke ${sender}:`,
            sendError
          );
        }
      }
    }
  }

  // Update session
  userSessions.set(sender, userSession);
});

// --- Menangani Error Global yang Tidak Tertangkap ---
process.on("unhandledRejection", (reason, promise) => {
  console.error("-----------------------------------");
  console.error("     UNHANDLED REJECTION!          ");
  console.error("-----------------------------------");
  console.error("Reason:", reason);
  console.error("Promise:", promise);
  // Pertimbangkan untuk keluar atau memberitahu admin
});

process.on("uncaughtException", (error) => {
  console.error("-----------------------------------");
  console.error("     UNCAUGHT EXCEPTION!           ");
  console.error("-----------------------------------");
  console.error("Error:", error);
  // Sebaiknya keluar dari aplikasi setelah ini karena state aplikasi bisa tidak konsisten
  process.exit(1);
});

// --- Inisialisasi Client ---
console.log("Memulai inisialisasi client WhatsApp...");
client.initialize().catch((err) => {
  console.error("FATAL: Gagal menginisialisasi client utama:", err);
  process.exit(1); // Keluar jika inisialisasi awal gagal total
});
