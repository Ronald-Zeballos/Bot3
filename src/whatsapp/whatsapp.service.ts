import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { google } from 'googleapis';
import * as PDFDocument from 'pdfkit';
import * as fs from 'fs';
import * as path from 'path';

type UserState = {
  state: string;
  serviceType?: string;
  appointmentDate?: string; // YYYY-MM-DD
  appointmentTime?: string; // HH:MM
  clientData?: { nombre?: string; telefono?: string; email?: string };
  lastOfferedSlots?: Array<{ row: number; date: string; time: string; label: string }>;
};

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  // Triggers (igual que tenías)
  private readonly TRIGGERS_TRIBUTARIO = new RegExp(/(impuestos|tributario|tributaria|fiscal|sat)/, 'i');
  private readonly TRIGGERS_LEGAL = new RegExp(/(legal|contrato|ley|abogado|jurídico)/, 'i');
  private readonly TRIGGERS_LABORAL = new RegExp(/(laboral|empleo|trabajo|contratación|despido)/, 'i');
  private readonly TRIGGERS_CONTABILIDAD = new RegExp(/(contabilidad|contable|libros contables|declaraciones|facturación)/, 'i');
  private readonly TRIGGERS_SISTEMAS = new RegExp(/(sistemas|software|redes|computadoras|informática|tecnología)/, 'i');

  private userStates = new Map<string, UserState>();

  private sheets: any;
  private readonly SPREADSHEET_ID = process.env.SHEETS_SPREADSHEET_ID as string;
  private readonly TAB_SLOTS = process.env.SHEETS_TAB_SLOTS || 'Horarios';
  private readonly TAB_APPTS = process.env.SHEETS_TAB_APPOINTMENTS || 'Citas';
  private readonly LOCAL_TZ = process.env.LOCAL_TZ || 'America/La_Paz';

  constructor() {
    this.setupGoogleSheetsAuth().catch((e) =>
      console.error('Error configurando Google Sheets:', e?.message || e)
    );
  }

  /* ===========================
     Google Sheets (solo sheets)
     =========================== */
  private async setupGoogleSheetsAuth() {
    if (!this.SPREADSHEET_ID) throw new Error('Falta SHEETS_SPREADSHEET_ID');
    let auth;
    const raw = process.env.GOOGLE_CREDENTIALS_JSON;
    if (raw && raw.trim()) {
      const creds = JSON.parse(raw);
      auth = new google.auth.GoogleAuth({
        credentials: creds,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
      auth = new google.auth.GoogleAuth({
        keyFile: process.env.GOOGLE_APPLICATION_CREDENTIALS,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } else {
      throw new Error(
        'No hay credenciales de Google. Define GOOGLE_CREDENTIALS_JSON o GOOGLE_APPLICATION_CREDENTIALS.'
      );
    }
    const client = await auth.getClient();
    this.sheets = google.sheets({ version: 'v4', auth: client });
  }

  /* =============
     WhatsApp send
     ============= */
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
      throw new Error(
        'No se pudo enviar el mensaje: ' +
          (error?.response?.data?.error?.message || error?.message)
      );
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
      throw new Error(
        'No se pudieron enviar los botones: ' +
          (error?.response?.data?.error?.message || error?.message)
      );
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

  /* =======
     Helpers
     ======= */
  private detectarTrigger(text: string, regex: RegExp): boolean {
    return regex.test(text.toLowerCase().trim());
  }
  private onlyDigits(s = '') { return String(s).replace(/[^\d]/g, ''); }
  private pad2(n: number | string) { return String(n).padStart(2, '0'); }

  private todayYMD() {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.LOCAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date());
      const get = (t: any) => parts.find(p => p.type === t)?.value || '';
      return { y: +get('year'), m: +get('month'), d: +get('day') };
    } catch {
      const d = new Date();
      return { y: d.getFullYear(), m: d.getMonth() + 1, d: d.getDate() };
    }
  }

  /* ==============================
     LÓGICA PRINCIPAL DE CONVERSA
     ============================== */
  async generarRespuesta(text: string, from: string): Promise<string> {
    const t = (text || '').toLowerCase().trim();
    const us = this.userStates.get(from) || { state: 'initial' };

    // FSM (flujos)
    if (us.state === 'awaiting_service_type') {
      return this.handleServiceSelection(text, from);
    } else if (us.state === 'awaiting_appointment_confirmation') {
      return this.handleAppointmentConfirmation(text, from);
    } else if (us.state === 'awaiting_slot_choice') {
      return this.handleSlotChoice(text, from);
    } else if (us.state === 'awaiting_name') {
      return this.handleNameInput(text, from);
    } else if (us.state === 'awaiting_phone') {
      return this.handlePhoneInput(text, from);
    } else if (us.state === 'awaiting_email') {
      return this.handleEmailInput(text, from);
    }

    // Inicio
    if (/(^|\b)(hola|buenas|hello|hi|buenos días|buenas tardes|buenas noches|inicio|empezar)(\b|$)/i.test(t)) {
      await this.sendWelcomeButtons(from);
      return '';
    }
    if (t.includes('gracias') || t.includes('thank you')) {
      return '¡Gracias a ti! ¿Hay algo más en lo que pueda ayudarte?';
    }
    if (/(adiós|chao|hasta luego)/i.test(t)) {
      return '¡Hasta luego! Si necesitas algo más, escribe “hola”.';
    }
    return "No estoy seguro de cómo responder a eso. Escribe 'hola' para ver opciones.";
  }

  private async sendWelcomeButtons(to: string) {
    const buttons = [
      { type: 'reply', reply: { id: 'servicios',    title: 'Ver servicios' } },
      { type: 'reply', reply: { id: 'agendar_cita', title: 'Agendar cita' } },
    ];
    const message =
      '¡Hola! 👋 Bienvenido a nuestros servicios profesionales. ¿En qué puedo ayudarte hoy?\n\n' +
      'Puedes seleccionar una opción o escribir directamente qué servicio necesitas:\n' +
      '- Asesoría tributaria, legal o laboral\n' +
      '- Contabilidad tercerizada\n' +
      '- Revisión de sistemas informáticos\n' +
      '- Otros servicios';

    this.userStates.set(to, { state: 'awaiting_service_type' });
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
    } else if (tl === 'servicios') {
      serviceType = 'Otros servicios o consultas generales';
    } else if (tl === 'agendar_cita') {
      serviceType = 'Sin especificar';
    } else {
      serviceType = 'Otros servicios o consultas generales';
    }

    const st = this.userStates.get(from) || { state: 'awaiting_service_type' };
    st.serviceType = serviceType;
    st.state = 'awaiting_appointment_confirmation';
    this.userStates.set(from, st);

    const redirectMessage =
      `He identificado que necesitas: ${serviceType}. \n\n` +
      `Serás contactado por nuestro especialista en breve al número +591 65900645. \n\n` +
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
    if (/(^|\b)(si|sí|agendar_si)(\b|$)/i.test(t)) {
      // 1) Leer slots disponibles (próx. 7 días)
      const slots = await this.getAvailableSlotsFromSheets(6, 7);
      if (!slots.length) {
        return 'Lo siento, no hay horarios disponibles en este momento. Intenta más tarde o contáctanos al +591 65900645.';
      }
      // 2) Mostrar lista y pedir número
      let msg = 'Estos son los horarios disponibles:\n\n';
      slots.forEach((s, i) => (msg += `${i + 1}. ${s.label}\n`));
      msg += '\nResponde con el número de la opción que prefieres.';
      const st = this.userStates.get(from) || { state: 'initial' };
      st.lastOfferedSlots = slots;
      st.state = 'awaiting_slot_choice';
      this.userStates.set(from, st);
      return msg;
    } else {
      this.userStates.set(from, { state: 'initial' });
      return 'De acuerdo. Serás contactado pronto por nuestro especialista. ¡Gracias!';
    }
  }

  private async handleSlotChoice(text: string, from: string): Promise<string> {
    const n = parseInt((text || '').trim(), 10);
    const st = this.userStates.get(from);
    if (!st || !Array.isArray(st.lastOfferedSlots) || !Number.isFinite(n) || n < 1 || n > st.lastOfferedSlots.length) {
      return 'Por favor, envía un número válido de la lista anterior.';
    }
    const chosen = st.lastOfferedSlots[n - 1];

    // Intentar reservar en la hoja (marca estado=RESERVADO en esa fila)
    const ok = await this.reserveSlotRow(chosen.row, from);
    if (!ok) {
      // Si otro lo tomó, pide otra opción
      st.state = 'awaiting_appointment_confirmation';
      this.userStates.set(from, st);
      return 'Ese horario acaba de ocuparse 😕. ¿Quieres intentar nuevamente? Responde "sí" para ver horarios disponibles.';
    }

    // Guardar selección y continuar con datos
    st.appointmentDate = chosen.date; // YYYY-MM-DD
    st.appointmentTime = chosen.time; // HH:MM
    st.state = 'awaiting_name';
    this.userStates.set(from, st);

    return 'Perfecto. Para agendar tu cita, necesito algunos datos.\n\nPor favor, escribe tu nombre completo.';
  }

  private async handleNameInput(text: string, from: string): Promise<string> {
    const st = this.userStates.get(from)!;
    st.clientData = st.clientData || {};
    st.clientData.nombre = text.trim();
    st.state = 'awaiting_phone';
    this.userStates.set(from, st);
    return 'Gracias. Ahora, por favor escribe tu número de teléfono.';
  }

  private async handlePhoneInput(text: string, from: string): Promise<string> {
    const st = this.userStates.get(from)!;
    st.clientData = st.clientData || {};
    st.clientData.telefono = this.onlyDigits(text);
    st.state = 'awaiting_email';
    this.userStates.set(from, st);
    return 'Ahora, por favor escribe tu correo electrónico.';
  }

  private async handleEmailInput(text: string, from: string): Promise<string> {
    const st = this.userStates.get(from)!;
    st.clientData = st.clientData || {};
    st.clientData.email = text.trim();
    const { appointmentDate, appointmentTime } = st;

    // Guardar en “Citas”
    await this.appendAppointmentRow({
      telefono: st.clientData.telefono || this.onlyDigits(from),
      nombre: st.clientData.nombre || '',
      email: st.clientData.email || '',
      servicio: st.serviceType || 'Sin especificar',
      fecha: appointmentDate!,
      hora: appointmentTime!,
      slotRow: (st.lastOfferedSlots?.find(s => s.date === appointmentDate && s.time === appointmentTime)?.row) || '',
    });

    // Confirmación
    await this.sendMessage(
      from,
      `¡Perfecto! Tu cita ha sido registrada para el ${appointmentDate} a las ${appointmentTime}.\n\n` +
      `Pronto recibirás una confirmación.`
    );

    // (Opcional) PDF local – puedes quitarlo si no lo usas
    try {
      const pdfUrl = await this.generateConfirmationPDF({
        clientData: st.clientData,
        serviceType: st.serviceType,
        appointmentDate,
        appointmentTime,
      });
      if (pdfUrl) await this.sendImage(from, pdfUrl, 'Aquí tienes tu comprobante de cita.');
    } catch (_) {}

    this.userStates.set(from, { state: 'initial' });
    return '¿Necesitas algo más?';
  }

  /* =========================
     Sheets: slots & reservas
     ========================= */
  private async getAvailableSlotsFromSheets(max = 6, daysAhead = 7): Promise<Array<{ row: number; date: string; time: string; label: string }>> {
    const { y, m, d } = this.todayYMD();
    const today = new Date(Date.UTC(y, m - 1, d));
    const until = new Date(today.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const r = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.SPREADSHEET_ID,
      range: `${this.TAB_SLOTS}!A2:E`,
    });
    const rows: string[][] = r.data.values || [];

    const out: Array<{ row: number; date: string; time: string; label: string }> = [];
    for (let i = 0; i < rows.length; i++) {
      const rowIdx = i + 2; // fila real en la hoja
      const [fecha, hora, estado] = [rows[i][0] || '', rows[i][1] || '', (rows[i][2] || '').toUpperCase()];
      if (estado !== 'DISPONIBLE') continue;
      // filtro por rango
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
    // Leemos C (estado) y si está DISPONIBLE → pasamos a RESERVADO
    const stateRange = `${this.TAB_SLOTS}!C${rowNumber}:E${rowNumber}`;
    const read = await this.sheets.spreadsheets.values.get({
      spreadsheetId: this.SPREADSHEET_ID,
      range: stateRange,
    });
    const cur = (read.data.values && read.data.values[0]) || [];
    const currentState = (cur[0] || '').toUpperCase();
    if (currentState !== 'DISPONIBLE') return false;

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: this.SPREADSHEET_ID,
      range: stateRange,
      valueInputOption: 'RAW',
      requestBody: { values: [[ 'RESERVADO', new Date().toISOString(), this.onlyDigits(byPhone) ]] },
    });
    return true;
  }

  private async appendAppointmentRow(opts: {
    telefono: string;
    nombre: string;
    email: string;
    servicio: string;
    fecha: string; // YYYY-MM-DD
    hora: string;  // HH:MM
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
    await this.sheets.spreadsheets.values.append({
      spreadsheetId: this.SPREADSHEET_ID,
      range: `${this.TAB_APPTS}!A1:J`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: [row] },
    });
  }

  /* ======================
     (Opcional) PDF simple
     ====================== */
  private async generateConfirmationPDF(state: any): Promise<string | null> {
    try {
      const doc = new PDFDocument();
      const safeName = (state.clientData?.nombre || 'Cliente').replace(/\s+/g, '_');
      const fileName = `cita_${safeName}_${Date.now()}.pdf`;
      const filePath = path.join(__dirname, '..', 'tmp', fileName);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      doc.pipe(fs.createWriteStream(filePath));

      doc.fontSize(20).text('Confirmación de Cita', 100, 100);
      doc.fontSize(12).text(`Nombre: ${state.clientData?.nombre || ''}`, 100, 150);
      doc.text(`Teléfono: ${state.clientData?.telefono || ''}`, 100, 170);
      doc.text(`Email: ${state.clientData?.email || ''}`, 100, 190);
      doc.text(`Servicio: ${state.serviceType || ''}`, 100, 210);
      doc.text(`Fecha: ${state.appointmentDate || ''}`, 100, 230);
      doc.text(`Hora: ${state.appointmentTime || ''}`, 100, 250);
      doc.end();

      // Aquí normalmente subirías a S3/GCS y devolverías la URL pública.
      // Mientras, devuelve una URL ficticia para no romper el flujo:
      return `https://ejemplo.com/pdfs/${fileName}`;
    } catch (e) {
      console.error('Error generando PDF:', e);
      return null;
    }
  }

  /* ============
     Utilidades
     ============ */
  getButtonTextById(buttonId: string): string {
    if (buttonId === 'servicios') return 'Ver servicios';
    if (buttonId === 'agendar_cita') return 'Agendar cita';
    if (buttonId === 'agendar_si') return 'Sí, agendar cita';
    if (buttonId === 'agendar_no') return 'No, gracias';
    return buttonId;
  }
}
