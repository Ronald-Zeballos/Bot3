
// src/whatsapp.service.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { google } from 'googleapis';
import * as PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as path from 'path';
import QRCode from 'qrcode';

type ClientData = { nombre?: string; telefono?: string; email?: string };
type SlotOffered = { row: number; date: string; time: string; label: string };

type UserState = {
  state: string;
  serviceType?: string;
  appointmentDate?: string; // YYYY-MM-DD
  appointmentTime?: string; // HH:MM
  clientData?: ClientData;
  lastOfferedSlots?: SlotOffered[];
  updatedAt?: number;
};

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  // Triggers por dominio
  private readonly TRIGGERS_TRIBUTARIO = new RegExp(/(impuestos|tributario|tributaria|fiscal|sat)/, 'i');
  private readonly TRIGGERS_LEGAL = new RegExp(/(legal|contrato|ley|abogado|jur[ií]dico)/, 'i');
  private readonly TRIGGERS_LABORAL = new RegExp(/(laboral|empleo|trabajo|contrataci[oó]n|despido)/, 'i');
  private readonly TRIGGERS_CONTABILIDAD = new RegExp(/(contabilidad|contable|libros contables|declaraciones|facturaci[oó]n)/, 'i');
  private readonly TRIGGERS_SISTEMAS = new RegExp(/(sistemas|software|redes|computadoras|inform[aá]tica|tecnolog[ií]a)/, 'i');

  private userStates = new Map<string, UserState>();

  private sheets: any;
  private SPREADSHEET_ID!: string;
  private readonly TAB_SLOTS = process.env.SHEETS_TAB_SLOTS || 'Horarios';
  private readonly TAB_APPTS = process.env.SHEETS_TAB_APPOINTMENTS || 'Citas';
  private readonly LOCAL_TZ = process.env.LOCAL_TZ || 'America/La_Paz';
  private readonly RETRY_ATTEMPTS = 3;
  private readonly RETRY_DELAY_MS = 600; // ms

  constructor() {
    this.setupGoogleSheetsAuth().catch((e) =>
      console.error('Error configurando Google Sheets:', e?.message || e)
    );
  }

/* =========================
     Google Sheets (autenticación robusta)
     ========================= */
  private async setupGoogleSheetsAuth() {
    this.SPREADSHEET_ID = (
      process.env.SHEETS_SPREADSHEET_ID ||
      process.env.GOOGLE_SHEETS_ID ||
      process.env.GOOGLE_SHEET_ID ||
      ''
    ).trim();
    if (!this.SPREADSHEET_ID) {
      throw new Error('Falta SHEETS_SPREADSHEET_ID/GOOGLE_SHEETS_ID (usa SOLO el ID de la planilla, no la URL).');
    }

    const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

    // 1) Preferimos GOOGLE_CREDENTIALS_JSON (JSON directo o base64)
    const raw = process.env.GOOGLE_CREDENTIALS_JSON?.trim();
    if (raw) {
      let creds: any;
      try {
        creds = JSON.parse(raw);
      } catch {
        try {
          const decoded = Buffer.from(raw, 'base64').toString('utf8');
          creds = JSON.parse(decoded);
        } catch {
          throw new Error('GOOGLE_CREDENTIALS_JSON no es JSON válido ni base64 de JSON.');
        }
      }
      const auth = new google.auth.GoogleAuth({ credentials: creds, scopes });
      this.sheets = google.sheets({ version: 'v4', auth });
      console.log('[sheets] auth por GOOGLE_CREDENTIALS_JSON ok');
      return;
    }

    // 2) Si no hay JSON, usar ruta a archivo
    const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (!keyFile) {
      throw new Error(
        'Faltan credenciales: define GOOGLE_CREDENTIALS_JSON (contenido) o GOOGLE_APPLICATION_CREDENTIALS (ruta a archivo .json).'
      );
    }
    if (keyFile.length > 300) {
      throw new Error('GOOGLE_APPLICATION_CREDENTIALS debe ser una *ruta* a archivo, no el contenido JSON.');
    }

    const auth = new google.auth.GoogleAuth({ keyFile, scopes });
    this.sheets = google.sheets({ version: 'v4', auth });
    console.log('[sheets] auth por GOOGLE_APPLICATION_CREDENTIALS ok:', keyFile);
}

  /* =========================
     Envío de mensajes WhatsApp
     ========================= */
  async sendMessage(to: string, message: string) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'text',
      text: { preview_url: false, body: message },
    };
    try {
      const response = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar mensaje:', error?.response?.data || error?.message);
      throw new Error('No se pudo enviar el mensaje: ' + (error?.response?.data?.error?.message || error?.message));
    }
  }

  async sendButtons(to: string, message: string, buttons: any[]) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: message },
        action: { buttons },
      },
    };
    try {
      const response = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar botones:', error?.response?.data || error?.message);
      throw new Error('No se pudieron enviar los botones: ' + (error?.response?.data?.error?.message || error?.message));
    }
  }

  async sendImage(to: string, imageUrl: string, caption: string) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'image',
      image: { link: imageUrl, caption },
    };
    try {
      const response = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return response.data;
    } catch (error: any) {
      console.error('Error al enviar imagen:', error?.response?.data || error?.message);
      const fallback = `${caption}\n\nSi no puedes ver la imagen, visita este enlace: ${imageUrl}`;
      return this.sendMessage(to, fallback);
    }
  }

  /* ===== Helpers ===== */
  private onlyDigits(s = '') {
    return String(s || '').replace(/[^\d]/g, '');
  }
  private detectarTrigger(text: string, regex: RegExp): boolean {
    return regex.test(text.toLowerCase().trim());
  }
  private todayYMD() {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.LOCAL_TZ,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(new Date());
      const get = (t: any) => parts.find((p) => p.type === t)?.value || '';
      return { y: +get('year'), m: +get('month'), d: +get('day') };
    } catch {
      const d = new Date();
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
    }
  }
  private sleep(ms: number): Promise<void> {
    return new Promise<void>((res) => setTimeout(() => res(), ms));
  }

  /* =========================
     Validaciones
     ========================= */
  private validarTelefono(telefono = ''): boolean {
    const t = this.onlyDigits(telefono);
    return /^\d{7,12}$/.test(t);
  }
  private validarEmail(email = ''): boolean {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  }
  private validarNombre(nombre = ''): boolean {
    const parts = String(nombre || '').trim().split(/\s+/);
    return parts.length >= 2 && parts.every((p) => p.length >= 2);
  }

  /* =========================
     Lógica principal
     ========================= */
  async generarRespuesta(text: string, from: string, buttonId?: string): Promise<string> {
    let us = this.userStates.get(from) || { state: 'initial' };
    us.updatedAt = Date.now();
    this.userStates.set(from, us);

    // Acciones por botones (sin recursión)
    if (buttonId) {
      switch (buttonId) {
        case 'servicios':
          return this.handleServiceSelection('servicios', from);
        case 'agendar_cita':
          // setear intención y pedir confirmación
          this.userStates.set(from, { ...us, state: 'awaiting_appointment_confirmation', serviceType: 'Sin especificar', updatedAt: Date.now() });
          return this.handleAppointmentConfirmation('sí', from);
        case 'agendar_si':
          return this.handleAppointmentConfirmation('sí', from);
        case 'agendar_no':
          this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
          return 'De acuerdo. Si necesitas algo más, escribe "hola".';
      }
    }

    // FSM por estado
    if (us.state === 'awaiting_service_type') {
      return this.handleServiceSelection(text, from);
    } else if (us.state === 'awaiting_appointment_confirmation') {
      return this.handleAppointmentConfirmation(text, from);
    } else if (us.state === 'awaiting_slot_choice') {
      return this.handleSlotChoice(text, from);
    } else if (us.state === 'awaiting_contact_inline') {
      return this.handleContactInline(text, from);
    }

    // Mensajes de inicio/fallback
    const t = (text || '').toLowerCase().trim();
    if (/(^|\b)(hola|buenas|hello|hi|buenos días|buenas tardes|buenas noches|inicio|empezar)(\b|$)/i.test(t)) {
      await this.sendWelcomeButtons(from);
      this.userStates.set(from, { state: 'awaiting_service_type', updatedAt: Date.now() });
      return '';
    }
    if (t.includes('gracias') || t.includes('thank you')) {
      return '¡Gracias a ti! ¿Necesitas algo más? Escribe "hola" para volver al menú.';
    }
    if (/(adiós|chao|hasta luego)/i.test(t)) {
      return '¡Hasta luego! Si necesitas algo más, escribe “hola”.';
    }

    // Si detecta servicio por palabras clave fuera de flujo
    if (
      this.detectarTrigger(t, this.TRIGGERS_TRIBUTARIO) ||
      this.detectarTrigger(t, this.TRIGGERS_LEGAL) ||
      this.detectarTrigger(t, this.TRIGGERS_LABORAL) ||
      this.detectarTrigger(t, this.TRIGGERS_CONTABILIDAD) ||
      this.detectarTrigger(t, this.TRIGGERS_SISTEMAS)
    ) {
      const st: UserState = { state: 'awaiting_appointment_confirmation', serviceType: text.trim(), updatedAt: Date.now() };
      this.userStates.set(from, st);
      return this.handleServiceSelection(text, from);
    }

    return '🤔 No entendí tu mensaje. Escribe "hola" para empezar o elige una de las opciones en pantalla.';
  }

  /* =========================
     Bienvenida y selección de servicio
     ========================= */
  private async sendWelcomeButtons(to: string) {
    const buttons = [
      { type: 'reply', reply: { id: 'servicios', title: 'Ver servicios' } },
      { type: 'reply', reply: { id: 'agendar_cita', title: 'Agendar cita' } },
    ];
    const message =
      '¡Hola! 👋 Bienvenido a nuestros servicios profesionales. ¿En qué puedo ayudarte hoy?\n\n' +
      'Puedes seleccionar una opción o escribir directamente qué servicio necesitas:\n' +
      '- Asesoría tributaria, legal o laboral\n' +
      '- Contabilidad tercerizada\n' +
      '- Revisión de sistemas informáticos\n' +
      '- Otros servicios';
    await this.sendButtons(to, message, buttons);
  }

  private async handleServiceSelection(text: string, from: string): Promise<string> {
    const tl = text.toLowerCase().trim();
    let serviceType = '';
    if (this.detectarTrigger(tl, this.TRIGGERS_TRIBUTARIO) || this.detectarTrigger(tl, this.TRIGGERS_LEGAL) || this.detectarTrigger(tl, this.TRIGGERS_LABORAL)) {
      serviceType = 'Asesoría tributaria, legal y laboral';
    } else if (this.detectarTrigger(tl, this.TRIGGERS_CONTABILIDAD)) {
      serviceType = 'Contabilidad tercerizada';
    } else if (this.detectarTrigger(tl, this.TRIGGERS_SISTEMAS)) {
      serviceType = 'Revisión de sistemas informáticos';
    } else if (tl === 'ver servicios' || tl === 'servicios') {
      serviceType = 'Otros servicios o consultas generales';
    } else if (tl === 'agendar cita' || tl === 'agendar_cita') {
      serviceType = 'Sin especificar';
    } else {
      serviceType = 'Otros servicios o consultas generales';
    }

    const st = this.userStates.get(from) || { state: 'awaiting_service_type' };
    st.serviceType = serviceType;
    st.state = 'awaiting_appointment_confirmation';
    st.updatedAt = Date.now();
    this.userStates.set(from, st);

    const redirectMessage =
      `He identificado que necesitas: *${serviceType}*.\n\n` +
      `¿Te gustaría agendar una cita ahora?`;

    const buttons = [
      { type: 'reply', reply: { id: 'agendar_si', title: 'Sí, agendar cita' } },
      { type: 'reply', reply: { id: 'agendar_no', title: 'No, gracias' } },
    ];
    await this.sendButtons(from, redirectMessage, buttons);
    return '';
  }

  private async handleAppointmentConfirmation(text: string, from: string): Promise<string> {
    const t = text.toLowerCase().trim();
    if (/(^|\b)(si|sí|agendar_si|sí, agendar|si, agendar)/i.test(t)) {
      const slots = await this.getAvailableSlotsFromSheets(6, 7);
      if (!slots.length) {
        return 'Lo siento, no hay horarios disponibles en este momento. Intenta más tarde o contáctanos al +591 65900645.';
      }
      let msg = 'Estos son los horarios disponibles:\n\n';
      slots.forEach((s, i) => (msg += `${i + 1}. ${s.label}\n`));
      msg += '\nResponde con el número de la opción que prefieres (ej. 1).';
      const st = this.userStates.get(from) || { state: 'awaiting_appointment_confirmation' };
      st.lastOfferedSlots = slots;
      st.state = 'awaiting_slot_choice';
      st.updatedAt = Date.now();
      this.userStates.set(from, st);
      return msg;
    } else {
      this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
      return 'De acuerdo. Serás contactado pronto por nuestro especialista. ¡Gracias! Si necesitas algo más escribe "hola".';
    }
  }

  private async handleSlotChoice(text: string, from: string): Promise<string> {
    const n = parseInt((text || '').trim(), 10);
    const st = this.userStates.get(from);
    if (!st || !Array.isArray(st.lastOfferedSlots) || !Number.isFinite(n) || n < 1 || n > st.lastOfferedSlots.length) {
      return 'Por favor, envía un número válido de la lista anterior (ej. 1).';
    }
    const chosen = st.lastOfferedSlots[n - 1];

    // Intentar reservar en la hoja
    const ok = await this.reserveSlotRow(chosen.row, from).catch(() => false);
    if (!ok) {
      st.state = 'awaiting_appointment_confirmation';
      this.userStates.set(from, st);
      return 'Ese horario acaba de ocuparse 😕. Responde "sí" para ver otros horarios disponibles.';
    }

    // Guardar selección y pedir datos en un solo paso (más al grano)
    st.appointmentDate = chosen.date;
    st.appointmentTime = chosen.time;
    st.state = 'awaiting_contact_inline';
    st.updatedAt = Date.now();
    this.userStates.set(from, st);

    return `Reservé provisionalmente *${chosen.label}*.

Por favor envía en *un solo mensaje*:
*Nombre completo* | *Teléfono* | *Email*

Ejemplo:
Juan Pérez | 65900645 | juan@dominio.com`;
  }

  /* =========================
     Captura de datos "inline"
     ========================= */
  private parseInlineContact(text: string): ClientData {
    const emailMatch = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    const phoneMatch = text.replace(/\s+/g, '').match(/\d{7,12}/);
    let nombre = text;
    if (emailMatch) nombre = nombre.replace(emailMatch[0], ' ');
    if (phoneMatch) nombre = nombre.replace(phoneMatch[0], ' ');
    nombre = nombre.replace(/[|;,]/g, ' ').replace(/\s+/g, ' ').trim();
    return {
      nombre: nombre || undefined,
      telefono: phoneMatch ? phoneMatch[0] : undefined,
      email: emailMatch ? emailMatch[0] : undefined,
    };
  }

  private async handleContactInline(text: string, from: string): Promise<string> {
    const st = this.userStates.get(from)!;
    const cd = this.parseInlineContact(text);

    const faltantes: string[] = [];
    if (!this.validarNombre(cd.nombre || '')) faltantes.push('nombre completo');
    if (!this.validarTelefono(cd.telefono || '')) faltantes.push('teléfono (7–12 dígitos)');
    if (!this.validarEmail(cd.email || '')) faltantes.push('email válido');

    if (faltantes.length) {
      return `Me faltan: ${faltantes.join(', ')}.
Envíalo así: *Nombre completo | Teléfono | Email*`;
    }

    st.clientData = cd;
    try {
      await this.appendAppointmentRow({
        telefono: cd.telefono!,
        nombre: cd.nombre!,
        email: cd.email!,
        servicio: st.serviceType || 'Sin especificar',
        fecha: st.appointmentDate!,
        hora: st.appointmentTime!,
        slotRow:
          st.lastOfferedSlots?.find((s) => s.date === st.appointmentDate && s.time === st.appointmentTime)?.row || '',
      });
    } catch (e) {
      console.error('Error guardando cita en Sheets:', e);
      return 'Ocurrió un problema al guardar tu cita. Por favor intenta nuevamente más tarde o llama al +591 65900645.';
    }

    const confirmadoMsg = `✅ *Tu cita está confirmada*

📅 Fecha: ${st.appointmentDate}
🕒 Hora: ${st.appointmentTime}
🧾 Servicio: ${st.serviceType}
👤 Nombre: ${cd.nombre}
📞 Tel: ${cd.telefono}
✉ Email: ${cd.email}

Si deseas cancelar o reprogramar, responde "Cancelar cita" o contáctanos al +591 65900645.`;

    await this.sendMessage(from, confirmadoMsg);

    // (Opcional) PDF
    try {
      const pdfUrl = await this.generateConfirmationPDF({
        clientData: cd,
        serviceType: st.serviceType,
        appointmentDate: st.appointmentDate,
        appointmentTime: st.appointmentTime,
      });
      if (pdfUrl) {
        await this.sendImage(from, pdfUrl, 'Aquí tienes tu comprobante de cita. Guárdalo como comprobante.');
      }
    } catch {}

    this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
    return '¿Necesitas algo más? Escribe "hola" para volver al menú.';
  }

  /* =========================
     Sheets - Helpers con reintentos
     ========================= */
  private async sheetsRequest<T>(fn: () => Promise<T>, attempts = this.RETRY_ATTEMPTS): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        await this.sleep(this.RETRY_DELAY_MS * (i + 1));
      }
    }
    throw lastErr;
  }

  private async getAvailableSlotsFromSheets(max = 6, daysAhead = 7): Promise<SlotOffered[]> {
    const { y, m, d } = this.todayYMD();
    const today = new Date(Date.UTC(y, m - 1, d));
    const until = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const r: any = await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.SPREADSHEET_ID,
        range: `${this.TAB_SLOTS}!A2:E`,
      })
    );

    const rows: string[][] = r.data.values || [];
    const out: SlotOffered[] = [];
    for (let i = 0; i < rows.length; i++) {
      const rowIdx = i + 2; // fila real
      const [fecha, hora, estado] = [rows[i][0] || '', rows[i][1] || '', (rows[i][2] || '').toUpperCase()];
      if (estado !== 'DISPONIBLE') continue;
      const parts = (fecha || '').split('-').map(Number);
      if (parts.length !== 3) continue;
      const dt = new Date(Date.UTC(parts[0], parts[1] - 1, parts[2]));
      if (dt < today || dt > until) continue;
      const label = `${fecha} a las ${hora}`;
      out.push({ row: rowIdx, date: fecha, time: hora, label });
      if (out.length >= max) break;
    }
    return out;
  }

  private async reserveSlotRow(rowNumber: number, byPhone: string): Promise<boolean> {
    const stateRange = `${this.TAB_SLOTS}!C${rowNumber}:E${rowNumber}`;
    const read: any = await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.get({
        spreadsheetId: this.SPREADSHEET_ID,
        range: stateRange,
      })
    );
    const cur = (read.data.values && read.data.values[0]) || [];
    const currentState = (cur[0] || '').toUpperCase();
    if (currentState !== 'DISPONIBLE') return false;

    await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.update({
        spreadsheetId: this.SPREADSHEET_ID,
        range: stateRange,
        valueInputOption: 'RAW',
        requestBody: { values: [['RESERVADO', new Date().toISOString(), this.onlyDigits(byPhone)]] },
      })
    );
    return true;
  }

  private async appendAppointmentRow(opts: {
    telefono: string;
    nombre: string;
    email: string;
    servicio: string;
    fecha: string; // YYYY-MM-DD
    hora: string; // HH:MM
    slotRow: number | string;
  }) {
    const row = [
      new Date().toISOString(),
      this.onlyDigits(opts.telefono || ''),
      String(opts.nombre || ''),
      String(opts.email || ''),
      String(opts.servicio || ''),
      String(opts.fecha || ''),
      String(opts.hora || ''),
      'PENDIENTE',
      String(opts.slotRow || ''),
      '', // calendar_event_id (lo pondrá Apps Script)
    ];
    await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.append({
        spreadsheetId: this.SPREADSHEET_ID,
        range: `${this.TAB_APPTS}!A1:J`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: [row] },
      })
    );
  }

  /* =========================
     PDF con QR (corrige TS2345 en 'finish')
     ========================= */
  private async generateConfirmationPDF(state: any): Promise<string | null> {
    try {
      const safeName = (state.clientData?.nombre || 'Cliente').replace(/\s+/g, '_');
      const fileName = `cita_${safeName}_${Date.now()}.pdf`;
      const tmpDir = path.join(__dirname, '..', 'tmp');
      await fsp.mkdir(tmpDir, { recursive: true });
      const filePath = path.join(tmpDir, fileName);

      // QR con info esencial
      const qrText = JSON.stringify({
        nombre: state.clientData?.nombre,
        telefono: state.clientData?.telefono,
        email: state.clientData?.email,
        fecha: state.appointmentDate,
        hora: state.appointmentTime,
        servicio: state.serviceType,
      });
      const qrBuffer = await QRCode.toBuffer(qrText, { type: 'png', errorCorrectionLevel: 'M' });

      // Crear PDF
      const doc = new PDFDocument({ margin: 40 });
      const stream = fs.createWriteStream(filePath);
      doc.pipe(stream);

      const logoPath = path.join(__dirname, '..', 'assets', 'logo.png');
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, { width: 120 });
        } catch {
          /* ignore */
        }
      }

      doc.moveDown(1);
      doc.fontSize(18).text('Confirmación de Cita', { align: 'left' });
      doc.moveDown(0.5);
      doc.fontSize(12).text(`Nombre: ${state.clientData?.nombre || ''}`);
      doc.text(`Teléfono: ${state.clientData?.telefono || ''}`);
      doc.text(`Email: ${state.clientData?.email || ''}`);
      doc.text(`Servicio: ${state.serviceType || ''}`);
      doc.text(`Fecha: ${state.appointmentDate || ''}`);
      doc.text(`Hora: ${state.appointmentTime || ''}`);
      doc.moveDown(1);
      doc.text('ID de reserva: ' + Date.now().toString(), { oblique: true });
      doc.moveDown(1);

      // Insertar QR
      try {
        const qrY = doc.y;
        doc.image(qrBuffer, doc.x, qrY, { width: 120 });
      } catch {
        /* ignore */
      }

      doc.end();

      // Esperar a que termine de escribirse (corrección TS2345)
      await new Promise<void>((resolve, reject) => {
        stream.on('finish', () => resolve());
        stream.on('error', (err) => reject(err));
      });

      // TODO: subir a S3/GCS y devolver URL pública real
      return `https://ejemplo.com/pdfs/${fileName}`;
    } catch (e) {
      console.error('Error generando PDF:', e);
      return null;
    }
  }

  /* =========================
     Utilidad botones (por si lo necesitas)
     ========================= */
  getButtonTextById(buttonId: string): string {
    if (buttonId === 'servicios') return 'Ver servicios';
    if (buttonId === 'agendar_cita') return 'Agendar cita';
    if (buttonId === 'agendar_si') return 'Sí, agendar cita';
    if (buttonId === 'agendar_no') return 'No, gracias';
    return buttonId;
  }
}
