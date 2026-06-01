import nodemailer from "nodemailer";

// ─── Transporter ──────────────────────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  host:   process.env.SMTP_HOST,
  port:   parseInt(process.env.SMTP_PORT || "587"),
  secure: process.env.SMTP_PORT === "465",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

// ─── HTML-Template ────────────────────────────────────────────────────────────
function buildConfirmationHtml({ name, slotLabel, calendarLink }) {
  return `<!DOCTYPE html>
<html lang="de">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Terminbestätigung</title>
</head>
<body style="margin:0;padding:0;background:#f0f4f8;font-family:'Roboto',Arial,sans-serif;">

  <!-- Wrapper -->
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0f4f8;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(14,81,160,0.12);">

          <!-- Header -->
          <tr>
            <td style="background:linear-gradient(135deg,#0E51A0 0%,#1a6bc9 100%);padding:40px 48px 36px;text-align:center;position:relative;">
              <div style="font-family:'Rubik',Arial,sans-serif;font-size:28px;font-weight:700;color:#ffffff;letter-spacing:-0.5px;">
                ${process.env.COMPANY_NAME || "talkingHEADS"}
              </div>
              <div style="margin-top:8px;font-size:13px;color:rgba(255,255,255,0.75);letter-spacing:1px;text-transform:uppercase;">${process.env.COMPANY_TAGLINE || ""}</div>
              <div style="position:absolute;top:-20px;right:-20px;width:120px;height:120px;background:rgba(234,148,19,0.15);border-radius:50%;"></div>
            </td>
          </tr>

          <!-- Hero Badge -->
          <tr>
            <td align="center" style="padding:36px 48px 8px;">
              <div style="display:inline-block;background:linear-gradient(135deg,#EA9413,#f5b543);color:#ffffff;font-family:'Rubik',Arial,sans-serif;font-size:13px;font-weight:600;letter-spacing:1.5px;text-transform:uppercase;padding:8px 20px;border-radius:100px;">
                ✓ &nbsp;Termin bestätigt
              </div>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding:20px 48px 0;text-align:center;">
              <h1 style="margin:0;font-family:'Rubik',Arial,sans-serif;font-size:26px;font-weight:700;color:#1a202c;line-height:1.3;">
                Hey ${name},<br>wir freuen uns auf Dich!
              </h1>
              <p style="margin:16px 0 0;font-size:16px;color:#4a5568;line-height:1.6;">
                Dein kostenloses Erstgespräch mit ${process.env.COMPANY_NAME || "talkingHEADS"} ist gebucht.<br>
                Hier sind Deine Termindaten auf einen Blick:
              </p>
            </td>
          </tr>

          <!-- Slot Card -->
          <tr>
            <td style="padding:28px 48px;">
              <table width="100%" cellpadding="0" cellspacing="0"
                style="background:#f7f9fc;border:2px solid #e2eaf5;border-radius:12px;border-left:5px solid #0E51A0;">
                <tr>
                  <td style="padding:24px 28px;">
                    <div style="font-size:12px;color:#0E51A0;font-weight:600;letter-spacing:1px;text-transform:uppercase;margin-bottom:8px;">Dein Termin</div>
                    <div style="font-family:'Rubik',Arial,sans-serif;font-size:22px;font-weight:700;color:#1a202c;">
                      📅 &nbsp;${slotLabel}
                    </div>
                    <div style="margin-top:10px;font-size:14px;color:#4a5568;">Dauer: ca. 45 Minuten · Online (Link folgt)</div>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- What to expect -->
          <tr>
            <td style="padding:0 48px 28px;">
              <div style="font-family:'Rubik',Arial,sans-serif;font-size:16px;font-weight:600;color:#1a202c;margin-bottom:16px;">Was Dich erwartet:</div>
              <table width="100%" cellpadding="0" cellspacing="0">
                ${["Wir analysieren Deine aktuelle Situation", "Du bekommst konkrete, umsetzbare Impulse", "Kein Verkaufsgespräch — echter Mehrwert"].map(item => `
                <tr>
                  <td style="padding:6px 0;">
                    <table cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="width:28px;vertical-align:top;padding-top:1px;">
                          <div style="width:20px;height:20px;background:#EA9413;border-radius:50%;text-align:center;line-height:20px;font-size:11px;color:#fff;font-weight:700;">✓</div>
                        </td>
                        <td style="font-size:15px;color:#4a5568;padding-left:8px;">${item}</td>
                      </tr>
                    </table>
                  </td>
                </tr>`).join("")}
              </table>
            </td>
          </tr>

          <!-- CTA Button -->
          ${calendarLink ? `
          <tr>
            <td align="center" style="padding:0 48px 36px;">
              <a href="${calendarLink}"
                style="display:inline-block;background:linear-gradient(135deg,#0E51A0,#1a6bc9);color:#ffffff;font-family:'Rubik',Arial,sans-serif;font-size:15px;font-weight:600;text-decoration:none;padding:14px 36px;border-radius:100px;box-shadow:0 4px 16px rgba(14,81,160,0.3);">
                Im Kalender öffnen
              </a>
            </td>
          </tr>` : ""}

          <!-- Divider -->
          <tr>
            <td style="padding:0 48px;">
              <hr style="border:none;border-top:1px solid #e2eaf5;margin:0;">
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding:28px 48px;text-align:center;">
              <p style="margin:0;font-size:13px;color:#a0aec0;line-height:1.6;">
                Fragen? Antworte einfach auf diese E-Mail oder schreib uns direkt.<br>
                <strong style="color:#0E51A0;">${process.env.COMPANY_NAME || "talkingHEADS"} Digital Marketing</strong>
              </p>
              ${process.env.COMPANY_WEBSITE ? `<p style="margin:12px 0 0;font-size:11px;color:#cbd5e0;">${process.env.COMPANY_WEBSITE}</p>` : ""}
            </td>
          </tr>

          <!-- Bottom stripe -->
          <tr>
            <td style="background:linear-gradient(135deg,#0E51A0,#1a6bc9);height:6px;"></td>
          </tr>

        </table>
      </td>
    </tr>
  </table>

</body>
</html>`;
}

// ─── Send ─────────────────────────────────────────────────────────────────────
export async function sendBookingConfirmation({ name, email, slotLabel, calendarLink }) {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS) {
    console.warn("[Email] SMTP not configured — skipping confirmation email");
    return;
  }

  await transporter.sendMail({
    from: `"${process.env.COMPANY_NAME || "talkingHEADS"} Assistent" <${process.env.SMTP_USER}>`,
    to:   `"${name}" <${email}>`,
    subject: `✅ Dein Termin: ${slotLabel}`,
    html:    buildConfirmationHtml({ name, slotLabel, calendarLink }),
  });

  console.log(`[Email] Bestätigung gesendet an ${email}`);
}
