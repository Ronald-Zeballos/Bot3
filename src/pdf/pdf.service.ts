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

type PdfState = {
  clientData: ClientData;
  serviceType: string;
  appointmentDate: string; // YYYY-MM-DD
  appointmentTime: string; // HH:mm
};

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

  /* =========================
     GENERADOR DE PDF (estético)
     ========================= */
  async generateConfirmationPDFBuffer(state: PdfState): Promise<{ buffer: Buffer; filename: string }> {
    const safeName = (state.clientData?.nombre || 'Cliente').replace(/\s+/g, '_');
    const filename = `cita_${safeName}_${Date.now()}.pdf`;

    // Paleta institucional (predomina azul)
    const COLORS = {
      primary: '#0b57d0',
      primaryDark: '#0a45a7',
      text: '#1f2937',
      muted: '#6b7280',
      line: '#dbe3f8',
      badgeBg: '#e9f0ff',
      badgeText: '#0a45a7',
    };

    // Resolución de ruta de logo:
    // 1) env var LOGO_PATH (opcional)
    // 2) Bot3/public/logo-russel.png (pedido)
    // 3) ./public/logo-russel.png relativo al cwd
    // 4) ./assets/logo.png (fallback)
    const logoCandidates = [
      process.env.LOGO_PATH,
      path.resolve(process.cwd(), 'Bot3', 'public', 'logo-russel.png'),
      path.resolve(process.cwd(), 'public', 'logo-russel.png'),
      path.resolve(__dirname, '..', 'assets', 'logo.png'),
      path.resolve(__dirname, '..', '..', 'public', 'logo-russel.png'),
    ].filter(Boolean) as string[];
    const logoPath = logoCandidates.find((p) => {
      try {
        return fs.existsSync(p);
      } catch {
        return false;
      }
    });

    // utilidades de formato
    const toTitle = (s = '') => String(s || '').replace(/\s+/g, ' ').trim();
    const nowStr = new Intl.DateTimeFormat('es-BO', {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone: 'America/La_Paz',
    }).format(new Date());

    const bookingId = this.makeBookingId(state);

    return await new Promise((resolve, reject) => {
      const doc = new (PDFDocument as any)({ margin: 48, size: 'A4', bufferPages: true });
      const chunks: Buffer[] = [];

      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), filename }));
      doc.on('error', reject);

      // ======= HEADER DECORATIVO
      this.drawHeaderBand(doc, COLORS);

      // Logo chico arriba-izquierda
      if (logoPath) {
        try {
          doc.image(logoPath, 52, 42, { width: 80 }); // pequeño en esquina sup. izquierda
        } catch {}
      }

      // Títulos
      doc
        .fillColor(COLORS.primaryDark)
        .font('Helvetica-Bold')
        .fontSize(20)
        .text('Comprobante de Cita', 0, 52, { align: 'right' });

      doc
        .fillColor(COLORS.text)
        .font('Helvetica')
        .fontSize(11)
        .text(COMPANY_NAME, { align: 'right' });

      // Línea base del encabezado
      doc
        .moveTo(50, 100)
        .lineTo(doc.page.width - 50, 100)
        .lineWidth(1)
        .strokeColor(COLORS.line)
        .stroke();

      // ======= MARCA DE AGUA (logo grande centrado, casi transparente)
      if (logoPath) {
        try {
          const wmWidth = doc.page.width * 0.55;
          const wmX = (doc.page.width - wmWidth) / 2;
          const wmY = (doc.page.height - wmWidth * 0.6) / 2; // aprox proporción
          doc.save();
          doc.opacity(0.06);
          doc.image(logoPath, wmX, wmY, { width: wmWidth });
          doc.restore();
        } catch {}
      }

      // ======= BADGE (ID de reserva)
      const badgeY = 112;
      const badgeHeight = 22;
      const badgeWidth = 180;
      const badgeX = doc.page.width - 50 - badgeWidth;
      doc
        .roundedRect(badgeX, badgeY, badgeWidth, badgeHeight, 6)
        .fillAndStroke(COLORS.badgeBg, COLORS.line);
      doc
        .fillColor(COLORS.badgeText)
        .font('Helvetica-Bold')
        .fontSize(10)
        .text(`ID de reserva: ${bookingId}`, badgeX, badgeY + 5, { width: badgeWidth, align: 'center' });

      // ======= TARJETA PRINCIPAL (datos)
      const cardTop = 150;
      const cardLeft = 50;
      const cardWidth = doc.page.width - 100;
      const cardHeight = 250;

      doc
        .roundedRect(cardLeft, cardTop, cardWidth, cardHeight, 14)
        .lineWidth(1)
        .fillOpacity(1)
        .fill('#ffffff')
        .strokeColor(COLORS.line)
        .stroke();

      // Barra vertical azul a la izquierda de la tarjeta
      doc
        .save()
        .rect(cardLeft, cardTop, 6, cardHeight)
        .fill(COLORS.primary)
        .restore();

      // Texto dentro de la tarjeta
      const innerLeft = cardLeft + 20;
      const innerTop = cardTop + 18;
      const colGap = 16;

      // TITULO de sección
      doc
        .fillColor(COLORS.primaryDark)
        .font('Helvetica-Bold')
        .fontSize(14)
        .text('Detalles de la cita', innerLeft, innerTop);

      // Subtext generado
      doc
        .fillColor(COLORS.muted)
        .font('Helvetica')
        .fontSize(10)
        .text(`Generado: ${nowStr} (America/La_Paz)`);

      // Separador fino
      doc
        .moveTo(innerLeft, innerTop + 32)
        .lineTo(cardLeft + cardWidth - 20, innerTop + 32)
        .lineWidth(1)
        .strokeColor(COLORS.line)
        .stroke();

      // Columna izquierda (datos del cliente)
      const infoY = innerTop + 48;
      let x = innerLeft;
      let y = infoY;

      y = this.infoRow(doc, x, y, 'Nombre', toTitle(state.clientData?.nombre || '—'), COLORS);
      y = this.infoRow(doc, x, y, 'Teléfono', state.clientData?.telefono || '—', COLORS);
      y = this.infoRow(doc, x, y, 'Email', (state.clientData?.email || '—'), COLORS);

      // Columna centro (servicio/fecha/hora)
      x = innerLeft + 200;
      y = infoY;
      y = this.infoRow(doc, x, y, 'Servicio', toTitle(state.serviceType || '—'), COLORS);
      y = this.infoRow(doc, x, y, 'Fecha', state.appointmentDate || '—', COLORS);
      y = this.infoRow(doc, x, y, 'Hora', state.appointmentTime || '—', COLORS);

      // Columna derecha (QR)
      const qrBoxX = cardLeft + cardWidth - 20 - 140;
      const qrBoxY = infoY - 8;
      const qrBoxSize = 140;

      // Marco del QR
      doc
        .roundedRect(qrBoxX, qrBoxY, qrBoxSize, qrBoxSize, 10)
        .strokeColor(COLORS.line)
        .lineWidth(1)
        .stroke();

      // Generar QR y dibujar dentro
      (async () => {
        try {
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
            generado: nowStr,
          };
          const qrBuffer = await QRCode.toBuffer(JSON.stringify(qrPayload), { type: 'png', errorCorrectionLevel: 'M', margin: 1 });
          const inset = 10;
          doc.image(qrBuffer, qrBoxX + inset, qrBoxY + inset, { width: qrBoxSize - inset * 2 });
        } catch {
          // ignora si falla QR
        }

        // ======= SECCIÓN UBICACIÓN & HORARIOS
        const sectionY = cardTop + cardHeight + 20;

        // Sección ubicación
        this.sectionHeading(doc, 'Ubicación', COLORS, sectionY);
        doc
          .fillColor(COLORS.text)
          .font('Helvetica')
          .fontSize(11)
          .text(
            'Russell Bedford Bolivia – Encinas Auditores y Consultores SRL',
            50,
            sectionY + 18,
            { width: doc.page.width - 100 }
          )
          .moveDown(0.3);

        // Enlace clickeable a Google Maps (exactamente como lo pediste)
        doc
          .fillColor(COLORS.primaryDark)
          .font('Helvetica-Bold')
          .text(COMPANY_MAPS_URL, {
            link: COMPANY_MAPS_URL,
            underline: true,
          });

        // Horarios
        const horariosY = sectionY + 62;
        this.sectionHeading(doc, 'Atención', COLORS, horariosY);
        doc
          .fillColor(COLORS.text)
          .font('Helvetica')
          .fontSize(11)
          .text(HOURS_TEXT, 50, horariosY + 18);

        // Notas / Recomendaciones
        const notesY = horariosY + 58;
        this.sectionHeading(doc, 'Recomendaciones', COLORS, notesY);
        doc
          .fillColor(COLORS.text)
          .font('Helvetica')
          .fontSize(11)
          .text('• Preséntate 5 minutos antes de la cita.', 50, notesY + 18)
          .text('• Trae tu documentación o información relevante.', 50)
          .text(`• Si necesitas reprogramar o cancelar, contáctanos: ${COMPANY_PHONE}.`, 50);

        // ======= FOOTER
        this.drawFooter(doc, COLORS, bookingId);

        // FIN
        doc.end();
      })();
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
     HELPERS DE DIBUJO/FORMATO
     ========================= */
  private drawHeaderBand(doc: PDFKit.PDFDocument, COLORS: any) {
    // Banda superior azul con sutil variación (dos rectángulos)
    doc
      .save()
      .rect(0, 0, doc.page.width, 40)
      .fill(COLORS.primary);
    doc
      .rect(0, 40, doc.page.width, 24)
      .fill(COLORS.badgeBg);
    doc.restore();
  }

  private drawFooter(doc: PDFKit.PDFDocument, COLORS: any, bookingId: string) {
    const y = doc.page.height - 70;

    // Línea separadora
    doc
      .moveTo(50, y)
      .lineTo(doc.page.width - 50, y)
      .lineWidth(1)
      .strokeColor(COLORS.line)
      .stroke();

    // Texto de contacto y marca
    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(9)
      .text(
        `${COMPANY_NAME} — ${COMPANY_PHONE}`,
        50,
        y + 10,
        { width: doc.page.width - 100, align: 'left' }
      );

    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(9)
      .text(
        `ID: ${bookingId}`,
        50,
        y + 10,
        { width: doc.page.width - 100, align: 'right' }
      );
  }

  private sectionHeading(doc: PDFKit.PDFDocument, title: string, COLORS: any, y: number) {
    const left = 50;
    const right = doc.page.width - 50;

    // diminuta pastilla azul
    doc
      .save()
      .roundedRect(left, y - 2, 8, 8, 2)
      .fill(COLORS.primary)
      .restore();

    doc
      .fillColor(COLORS.primaryDark)
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(title, left + 14, y - 6);

    // línea de apoyo
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
    COLORS: any
  ) {
    const labelWidth = 90;
    const lineHeight = 20;

    doc
      .fillColor(COLORS.muted)
      .font('Helvetica')
      .fontSize(10)
      .text(`${label}`, x, y, { width: labelWidth });

    doc
      .fillColor(COLORS.text)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(value, x + labelWidth + 8, y);

    // línea punteada sutil (opcional):
    doc
      .moveTo(x, y + lineHeight - 4)
      .lineTo(x + 260, y + lineHeight - 4)
      .dash(1, { space: 2 })
      .strokeColor('#eef2ff')
      .lineWidth(0.5)
      .stroke()
      .undash();

    return y + lineHeight;
  }

  private makeBookingId(state: PdfState) {
    const base = `${state.clientData?.telefono || ''}|${state.appointmentDate}|${state.appointmentTime}|${Date.now()}`;
    // Hash simple y corto base36
    let h = 0;
    for (let i = 0; i < base.length; i++) h = (h * 31 + base.charCodeAt(i)) >>> 0;
    return `RB-${h.toString(36).toUpperCase()}`;
  }
}
