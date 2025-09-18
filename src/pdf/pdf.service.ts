import { Injectable } from '@nestjs/common';
import * as PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';
import QRCode from 'qrcode';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const COMPANY_NAME = 'Russell Bedford Bolivia Encinas Auditores y Consultores SRL';

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

  async generateConfirmationPDFBuffer(state: {
    clientData: ClientData;
    serviceType: string;
    appointmentDate: string;
    appointmentTime: string;
  }): Promise<{ buffer: Buffer; filename: string }> {
    const safeName = (state.clientData?.nombre || 'Cliente').replace(/\s+/g, '_');
    const filename = `cita_${safeName}_${Date.now()}.pdf`;

    return await new Promise((resolve, reject) => {
      const doc = new (PDFDocument as any)({ margin: 40 });
      const chunks: Buffer[] = [];

      doc.on('data', (c: Buffer) => chunks.push(c));
      doc.on('end', () => resolve({ buffer: Buffer.concat(chunks), filename }));
      doc.on('error', reject);

      const primary = '#0b5ed7';
      const text = '#222';
      const muted = '#666';

      /* ===== Logo ===== */
      const logoBuf = resolveImageBuffer('logo.png');
      if (logoBuf) doc.image(logoBuf, { width: 110, align: 'left' });

      /* ===== Hero decorativo (opcional) ===== */
      let heroBuf = resolveImageBuffer('hero.jpg') || resolveImageBuffer('hero.png');
      if (heroBuf) {
        doc.moveDown(0.5);
        doc.image(heroBuf, { width: doc.page.width - 80, align: 'center' });
      }

      /* ===== Encabezado ===== */
      doc.moveDown(0.8);
      doc.fillColor(primary).fontSize(20).text('Confirmación de Cita', { align: 'center' });
      doc.moveDown(0.2);
      doc.fillColor(text).fontSize(16).text(COMPANY_NAME, { align: 'center' });
      doc.moveDown(0.6);

      doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor(primary).lineWidth(1).stroke();
      doc.moveDown(0.8);

      /* ===== Datos de la cita ===== */
      doc.fontSize(12).fillColor(text);
      const label = (t: string) => doc.fillColor(muted).text(t, { continued: true }).fillColor(text);

      label('Servicio: ').text(state.serviceType || '');
      label('Fecha: ').text(state.appointmentDate || '');
      label('Hora: ').text(state.appointmentTime || '');
      doc.moveDown(0.4);

      label('Nombre: ').text(state.clientData?.nombre || '');
      label('Teléfono: ').text(state.clientData?.telefono || '');
      label('Email: ').text(state.clientData?.email || '');
      doc.moveDown(0.8);

      /* ===== QR ===== */
      (async () => {
        try {
          const qrText = JSON.stringify({
            empresa: COMPANY_NAME,
            nombre: state.clientData?.nombre,
            telefono: state.clientData?.telefono,
            email: state.clientData?.email,
            fecha: state.appointmentDate,
            hora: state.appointmentTime,
            servicio: state.serviceType,
          });
          const qrBuffer = await QRCode.toBuffer(qrText, { type: 'png', errorCorrectionLevel: 'M', margin: 1, width: 160 });
          const x = doc.page.width - 40 - 120;
          const y = doc.y;
          doc.image(qrBuffer, x, y, { width: 120 });
          doc.rect(x - 8, y - 8, 136, 136).strokeColor('#ddd').lineWidth(0.5).stroke();
          doc.fontSize(9).fillColor(muted).text('Código QR de verificación', x - 6, y + 136 + 4, { width: 140, align: 'center' });
        } catch {}
        doc.moveDown(4);

        /* ===== Indicaciones ===== */
        doc.fillColor(text).fontSize(12).text('Por favor:', { underline: true });
        doc.text('• Presentarse 5 minutos antes de la cita');
        doc.text('• Traer documentación relevante');
        doc.text('• Contactarnos al +591 65900645 en caso de inconvenientes');
        doc.moveDown(0.8);

        /* ===== Pie ===== */
        doc.moveTo(40, doc.y).lineTo(doc.page.width - 40, doc.y).strokeColor('#e5e5e5').lineWidth(1).stroke();
        doc.moveDown(0.5);

        doc.fontSize(9).fillColor(muted)
          .text(`ID de reserva: ${Date.now()}`)
          .text('Dirección: Av. (tu dirección) – Santa Cruz de la Sierra')
          .text('Web: www.tu-dominio.com | Email: info@tu-dominio.com');

        /* ===== Marca de agua (opcional) ===== */
        const watermarkBuf = resolveImageBuffer('watermark.png');
        if (watermarkBuf) {
          const centerX = (doc.page.width - 300) / 2;
          const centerY = (doc.page.height - 300) / 2;
          doc.opacity(0.06).image(watermarkBuf, centerX, centerY, { width: 300 }).opacity(1);
        }

        doc.end();
      })();
    });
  }

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
}
