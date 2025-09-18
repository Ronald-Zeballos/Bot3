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

      try {
        const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
        if (fs.existsSync(logoPath)) doc.image(logoPath, { width: 120 });
      } catch {}

      doc.moveDown(1);
      doc.fontSize(18).text(COMPANY_NAME, { align: 'center', underline: true });
      doc.moveDown(0.2);
      doc.fontSize(16).text('Confirmación de Cita', { align: 'center' });
      doc.moveDown(1);

      doc.fontSize(12);
      doc.text(`Nombre: ${state.clientData?.nombre || ''}`);
      doc.text(`Teléfono: ${state.clientData?.telefono || ''}`);
      doc.text(`Email: ${state.clientData?.email || ''}`);
      doc.moveDown(0.5);
      doc.text(`Servicio: ${state.serviceType || ''}`);
      doc.text(`Fecha: ${state.appointmentDate || ''}`);
      doc.text(`Hora: ${state.appointmentTime || ''}`);
      doc.moveDown(1);

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
          const qrBuffer = await QRCode.toBuffer(qrText, { type: 'png', errorCorrectionLevel: 'M' });
          doc.image(qrBuffer, doc.page.width - 150, doc.y, { width: 100 });
        } catch {}
        doc.moveDown(3);

        doc.text('Por favor:', { underline: true });
        doc.text('• Presentarse 5 minutos antes de la cita');
        doc.text('• Traer documentación relevante');
        doc.text('• Contactarnos al +591 65900645 en caso de inconvenientes');
        doc.moveDown(1);

        doc.text(`ID de reserva: ${Date.now()}`, { oblique: true });
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