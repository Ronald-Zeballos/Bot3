import { Injectable } from '@nestjs/common';
import * as PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const COMPANY_NAME = 'Russell Bedford Bolivia Encinas Auditores y Consultores SRL';
const COMPANY_PHONE = '+591 65900645';
const COMPANY_MAPS_URL = 'https://maps.app.goo.gl/TU82fjJzHG3RBAbTA';
const HOURS_TEXT = 'Horario de atención: 08:00–12:00 y 14:30–18:30 (Lun–Vie)';

type ClientData = {
  nombre?: string;
  telefono?: string;
  email?: string;
};

/* ===== Helpers para cargar imágenes ===== */
function tryRead(filePath: string): Buffer | null {
  try {
    if (fs.existsSync(filePath)) return fs.readFileSync(filePath);
  } catch {}
  return null;
}

function resolveImageBuffer(filename: string): Buffer | null {
  // ENV override (ruta o data URL)
  const envPath = process.env[`PDF_${filename.toUpperCase()}_PATH`]?.trim();
  if (envPath) {
    if (envPath.startsWith('data:image')) {
      const base64 = envPath.split(',')[1];
      try { return Buffer.from(base64, 'base64'); } catch {}
    } else {
      const buf = tryRead(envPath);
      if (buf) return buf;
    }
  }

  // dist/pdf/filename
  const local = path.join(__dirname, filename);
  const bufLocal = tryRead(local);
  if (bufLocal) return bufLocal;

  // dist/../pdf/filename
  const sibling = path.join(__dirname, '..', 'pdf', filename);
  const bufSibling = tryRead(sibling);
  if (bufSibling) return bufSibling;

  // Proyecto: Bot3/public/logo-russel.png (común)
  if (filename === 'logo.png') {
    const bot3 = path.join(process.cwd(), 'Bot3', 'public', 'logo-russel.png');
    const pub = path.join(process.cwd(), 'public', 'logo-russel.png');
    return tryRead(bot3) || tryRead(pub) || null;
  }

  return null;
}

@Injectable()
export class PdfService {
  private s3: S3Client | null =
    process.env.AWS_S3_BUCKET &&
    process.env.AWS_REGION &&
    process.env.AWS_ACCESS_KEY_ID &&
    process.env.AWS_SECRET_ACCESS_KEY
      ? new S3Client({
          region: process.env.AWS_REGION!,
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
          },
        })
      : null;

  isS3Enabled() {
    return !!this.s3;
  }

  /* =====================================================
     PDF ESTÉTICO (alineado, azul, con QR, ubicación y horarios)
     ===================================================== */
  async generateConfirmationPDFBuffer(state: {
    clientData: ClientData;
    serviceType: string;
    appointmentDate: string; // YYYY-MM-DD
    appointmentTime: string; // HH:mm
  }): Promise<{ buffer: Buffer; filename: string }> {
    const safeName = (state.clientData?.nombre || 'Cliente').replace(/\s+/g, '_');
    const filename = `cita_${safeName}_${Date.now()}.pdf`;

    // Paleta
    const COLORS = {
      primary: '#0b57d0',
      primaryDark: '#0a45a7',
      text: '#1f2937',
      muted: '#6b7280',
      line: '#e5ecff',
      cardBorder: '#d6e2ff',
      badgeBg: '#e9f0ff',
      badgeText: '#0a45a7',
    };

    // Fecha/hora actual (La Paz)
    const generatedAt = new Intl.DateTimeFormat('es-BO', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/La_Paz',
    }).format(new Date());

    const bookingId = this.makeBookingId(state);

    // Prepara QR (antes de dibujar para evitar solapes/async raro)
    const qrPayload = {
      empresa: COMPANY_NAME,
      nombre: state.clientData?.nombre || '',
      telefono: state.clientData?.telefono || '',
      email: state.clientData?.email || '',
      fecha: state.appointmentDate,
      hora: state.appointmentTime,
      servicio: state.serviceType,
      ubicacion: COMPANY_MAPS_URL,
      id_reserva: bookingId,
      generado: generatedAt,
    };
    const qrBuffer = await QRCode.toBuffer(JSON.stringify(qrPayload), {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 1,
      scale: 6,
    });

    // Logo (mismo archivo para logo y marca de agua)
    const logoBuf = resolveImageBuffer('logo-russel.png');

    return await new Promise((resolve, reject) => {
      const doc = new (PDFDocument as any)({ margin: 48, size: 'A4', bufferPages: true });
      const chunks: Buffer[] = [];

      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), filename }));
      doc.on('error', reject);

      /* =============== LAYOUT BASE =============== */
      const PAGE = {
        left: 50,
        right: doc.page.width - 50,
        top: 40,
        bottom: doc.page.height - 50,
        width: doc.page.width,
        height: doc.page.height,
      };

      // Banda superior + barra secundaria
      this.drawHeaderBand(doc, COLORS);

      // Marca de agua centrada (misma imagen del logo, sin recortes)
      if (logoBuf) this.drawCenteredWatermark(doc, logoBuf, 0.06);

      // Logo pequeño arriba-izquierda
      if (logoBuf) {
        try {
          doc.image(logoBuf, PAGE.left, 46, { width: 84 });
        } catch {}
      }

      // Títulos alineados a la derecha
      doc
        .fillColor(COLORS.primaryDark)
        .font('Helvetica-Bold')
        .fontSize(22)
        .text('Comprobante de Cita', PAGE.left, 50, { align: 'right' });
      doc
        .fillColor(COLORS.text)
        .font('Helvetica')
        .fontSize(11)
        .text(COMPANY_NAME, { align: 'right' });

      // Línea base del header
      doc
        .moveTo(PAGE.left, 102)
        .lineTo(PAGE.right, 102)
        .lineWidth(1)
        .strokeColor(COLORS.line)
        .stroke();

      // Badge con ID
      const badge = { w: 190, h: 26, x: PAGE.right - 190, y: 112, r: 8 };
      doc
        .roundedRect(badge.x, badge.y, badge.w, badge.h, badge.r)
        .fillAndStroke(COLORS.badgeBg, COLORS.line);
      doc
        .fillColor(COLORS.badgeText)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(`ID de reserva: ${bookingId}`, badge.x, badge.y + 7, { width: badge.w, align: 'center' });

      /* =============== TARJETA DE DATOS =============== */
      const card = { x: PAGE.left, y: 150, w: PAGE.right - PAGE.left, h: 230, r: 14 };
      doc
        .roundedRect(card.x, card.y, card.w, card.h, card.r)
        .lineWidth(1)
        .fill('#ffffff')
        .strokeColor(COLORS.cardBorder)
        .stroke();

      // Barra de acento
      doc.save().rect(card.x, card.y, 6, card.h).fill(COLORS.primary).restore();

      const inner = { x: card.x + 20, y: card.y + 18, w: card.w - 40 };

      // Título de sección + subtexto
      doc
        .fillColor(COLORS.primaryDark)
        .font('Helvetica-Bold')
        .fontSize(14)
        .text('Detalles de la cita', inner.x, inner.y);
      doc
        .fillColor(COLORS.muted)
        .font('Helvetica')
        .fontSize(10)
        .text(`Generado: ${generatedAt} (America/La_Paz)`);

      // Separador
      const sepY = inner.y + 32;
      doc
        .moveTo(inner.x, sepY)
        .lineTo(inner.x + inner.w, sepY)
        .lineWidth(1)
        .strokeColor(COLORS.line)
        .stroke();

      // Rejilla 3 columnas (cliente | cita | QR)
      const col = {
        left: inner.x,
        center: inner.x + 210,
        rightBox: inner.x + inner.w - 140,
        y: sepY + 16,
        lineW: 260,
        rowH: 22,
      };

      // Columna izquierda (cliente)
      let y = col.y;
      y = this.infoRow(doc, col.left, y, 'Nombre', this.toTitle(state.clientData?.nombre || '—'), COLORS, col.lineW, col.rowH);
      y = this.infoRow(doc, col.left, y, 'Teléfono', state.clientData?.telefono || '—', COLORS, col.lineW, col.rowH);
      y = this.infoRow(doc, col.left, y, 'Email', state.clientData?.email || '—', COLORS, col.lineW, col.rowH);

      // Columna centro (cita)
      y = col.y;
      y = this.infoRow(doc, col.center, y, 'Servicio', this.toTitle(state.serviceType || '—'), COLORS, col.lineW, col.rowH);
      y = this.infoRow(doc, col.center, y, 'Fecha', state.appointmentDate || '—', COLORS, col.lineW, col.rowH);
      y = this.infoRow(doc, col.center, y, 'Hora', state.appointmentTime || '—', COLORS, col.lineW, col.rowH);

      // Caja de QR a la derecha
      const qrBox = { x: col.rightBox, y: col.y - 6, size: 140, r: 10 };
      doc
        .roundedRect(qrBox.x, qrBox.y, qrBox.size, qrBox.size, qrBox.r)
        .strokeColor(COLORS.line)
        .lineWidth(1)
        .stroke();
      const inset = 10;
      doc.image(qrBuffer, qrBox.x + inset, qrBox.y + inset, { width: qrBox.size - inset * 2 });
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(COLORS.muted)
        .text('Código QR de verificación', qrBox.x, qrBox.y + qrBox.size + 6, {
          width: qrBox.size,
          align: 'center',
        });

      /* =============== UBICACIÓN / HORARIOS / RECOMENDACIONES =============== */
      const sectionStartY = card.y + card.h + 24;

      // Ubicación
      this.sectionHeading(doc, 'Ubicación', COLORS, sectionStartY);
      doc
        .fillColor(COLORS.text)
        .font('Helvetica')
        .fontSize(11)
        .text('Russell Bedford Bolivia – Encinas Auditores y Consultores SRL', PAGE.left, sectionStartY + 18, {
          width: PAGE.right - PAGE.left,
        });
      doc
        .fillColor(COLORS.primaryDark)
        .font('Helvetica-Bold')
        .text(COMPANY_MAPS_URL, { link: COMPANY_MAPS_URL, underline: true });

      // Horarios
      const horariosY = sectionStartY + 58;
      this.sectionHeading(doc, 'Atención', COLORS, horariosY);
      doc
        .fillColor(COLORS.text)
        .font('Helvetica')
        .fontSize(11)
        .text(HOURS_TEXT, PAGE.left, horariosY + 18);

      // Recomendaciones
      const notesY = horariosY + 56;
      this.sectionHeading(doc, 'Recomendaciones', COLORS, notesY);
      doc
        .fillColor(COLORS.text)
        .font('Helvetica')
        .fontSize(11)
        .text('• Preséntate 5 minutos antes de la cita.', PAGE.left, notesY + 18)
        .text('• Trae tu documentación o información relevante.')
        .text(`• Si necesitas reprogramar o cancelar, contáctanos: ${COMPANY_PHONE}.`);

      // Footer
      this.drawFooter(doc, COLORS, bookingId);

      // FIN
      doc.end();
    });
  }

  /* =========================
     SUBIDA A S3 (opcional)
     ========================= */
  async uploadToS3(buffer: Buffer, filename: string, contentType = 'application/pdf'): Promise<string> {
    if (!this.s3) throw new Error('S3 no configurado.');
    const Bucket = process.env.AWS_S3_BUCKET!;
    await this.s3.send(
      new PutObjectCommand({
        Bucket,
        Key: `citas/${filename}`,
        Body: buffer,
        ContentType: contentType,
        ACL: 'public-read',
      })
    );
    return `https://${Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/citas/${filename}`;
  }

  /* =========================
     HELPERS VISUALES
     ========================= */
  private drawHeaderBand(doc: PDFKit.PDFDocument, COLORS: any) {
    doc.save();
    doc.rect(0, 0, doc.page.width, 42).fill(COLORS.primary);
    doc.rect(0, 42, doc.page.width, 24).fill('#f5f8ff');
    doc.restore();
  }

  private drawFooter(doc: PDFKit.PDFDocument, COLORS: any, bookingId: string) {
    const y = doc.page.height - 70;

    doc
      .moveTo(50, y)
      .lineTo(doc.page.width - 50, y)
      .lineWidth(1)
      .strokeColor(COLORS.line)
      .stroke();

    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(9)
      .text(`${COMPANY_NAME} — ${COMPANY_PHONE}`, 50, y + 10, {
        width: doc.page.width - 100,
        align: 'left',
      });

    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(9)
      .text(`ID: ${bookingId}`, 50, y + 10, {
        width: doc.page.width - 100,
        align: 'right',
      });
  }

  private sectionHeading(doc: PDFKit.PDFDocument, title: string, COLORS: any, y: number) {
    const left = 50;
    const right = doc.page.width - 50;

    doc.save().roundedRect(left, y - 2, 8, 8, 2).fill(COLORS.primary).restore();

    doc.fillColor(COLORS.primaryDark).font('Helvetica-Bold').fontSize(12).text(title, left + 14, y - 6);

    doc
      .moveTo(left, y + 16)
      .lineTo(right, y + 16)
      .lineWidth(1)
      .strokeColor(COLORS.line)
      .stroke();
  }

  private infoRow(
    doc: PDFKit.PDFDocument,
    x: number,
    y: number,
    label: string,
    value: string,
    COLORS: any,
    lineWidth = 260,
    rowH = 22,
  ) {
    const labelW = 80;

    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(10).text(label, x, y, { width: labelW });
    doc.fillColor(COLORS.text).font('Helvetica-Bold').fontSize(11).text(value, x + labelW + 10, y, {
      width: lineWidth - (labelW + 10),
      continued: false,
    });

    // Línea base sutil (punteada)
    doc
      .moveTo(x, y + rowH - 4)
      .lineTo(x + lineWidth, y + rowH - 4)
      .dash(1, { space: 2 })
      .strokeColor('#eef2ff')
      .lineWidth(0.5)
      .stroke()
      .undash();

    return y + rowH;
  }

  private drawCenteredWatermark(doc: PDFKit.PDFDocument, logoBuf: Buffer, opacity = 0.06) {
    try {
      // Caja segura para evitar recortes
      const padW = 160;
      const padH = 240;
      const maxW = doc.page.width - padW;
      const maxH = doc.page.height - padH;

      // Medidas reales de la imagen
      const img: any = (doc as any).openImage(logoBuf);
      const scale = Math.min(maxW / img.width, maxH / img.height, 1);
      const w = img.width * scale;
      const h = img.height * scale;

      const x = (doc.page.width - w) / 2;
      const y = (doc.page.height - h) / 2;

      doc.save();
      doc.opacity(opacity);
      doc.image(logoBuf, x, y, { width: w, height: h });
      doc.restore();
    } catch {
      // si falla, no dibuja marca de agua
    }
  }

  private toTitle(s = '') {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  private makeBookingId(state: { clientData: ClientData; appointmentDate: string; appointmentTime: string }) {
    const base = `${state.clientData?.telefono || ''}|${state.appointmentDate}|${state.appointmentTime}|${Date.now()}`;
    let h = 0;
    for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
    return `RB-${h.toString(36).toUpperCase()}`;
  }
}
