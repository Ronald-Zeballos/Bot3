import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as FormData from 'form-data';
import { SheetsService, SlotOffered } from '../sheets/sheets.service';
import { PdfService } from '../pdf/pdf.service';

const COMPANY_NAME = 'Russell Bedford Bolivia Encinas Auditores y Consultores SRL';

type ClientData = { nombre?: string; telefono?: string; email?: string; servicio?: string; fecha?: string; hora?: string; };

type UserState = {
  state: string;
  serviceType?: string;
  chosenDay?: string;
  appointmentDate?: string;
  appointmentTime?: string;
  clientData?: ClientData;
  lastOfferedSlots?: SlotOffered[];
  updatedAt?: number;
  currentStep?: number;
  totalSteps?: number;
};

type FieldKey = 'nombre' | 'telefono' | 'email';
type FormField = {
  key: FieldKey;
  prompt: (ctx: any) => string;
  validate: (v: string) => true | string;
  normalize?: (v: string) => string;
  optional?: boolean;
};

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  private readonly SERVICE_CATALOG = [
    { id: 'tributario', label: 'Asesoría Tributaria', aliases: ['impuestos', 'fiscal', 'sat', 'tributaria'] },
    { id: 'legal', label: 'Asesoría Legal', aliases: ['contrato', 'abogado', 'ley', 'juridico', 'jurídico'] },
    { id: 'laboral', label: 'Asesoría Laboral', aliases: ['empleo', 'trabajo', 'contratación', 'despido'] },
    { id: 'conta', label: 'Contabilidad', aliases: ['contable', 'libros', 'declaraciones', 'facturación', 'facturacion'] },
    { id: 'sistemas', label: 'Sistemas Informáticos', aliases: ['software', 'redes', 'informática', 'informatica', 'tecnología', 'tecnologia'] },
  ];

  private userStates = new Map<string, UserState>();
  private forms = new Map<
    string,
    { idx: number; data: ClientData; schema: FormField[]; serviceType: string; slots: SlotOffered[]; autofilledPhone: string }
  >();

  private readonly FORM_APPT: FormField[] = [
    {
      key: 'nombre',
      prompt: () => '🧍‍♀️ *Paso 1/3*: ¿Cuál es tu *nombre y apellido*?',
      validate: (v) => {
        const parts = String(v || '').trim().split(/\s+/);
        return (parts.length >= 2 && parts.every((p) => p.length >= 2)) || 'Escribe nombre y apellido (ej. María González).';
      },
    },
    {
      key: 'telefono',
      prompt: (ctx) =>
        `📞 *Paso 2/3*: ¿Confirmas este *número* para contactarte: *${ctx.autofilledPhone}*?\n\nResponde con:\n• *sí* para usarlo\n• O escribe otro número (7–12 dígitos)`,
      validate: (v) => /^\d{7,12}$/.test(String(v || '').replace(/[^\d]/g, '')) || 'Número inválido, usa 7–12 dígitos (ej. 65900645).',
      normalize: (v) => String(v || '').replace(/[^\d]/g, ''),
    },
    {
      key: 'email',
      prompt: () => '✉️ *Paso 3/3*: ¿Cuál es tu *email* para enviarte la confirmación?\n\nSi no tienes, escribe *omitir*.',
      validate: (v) => v === 'omitir' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v || '').trim()) || 'Email inválido (ej. nombre@ejemplo.com).',
      optional: true,
      normalize: (v) => (v === 'omitir' ? '' : String(v || '').trim()),
    },
  ];

  private readonly LOCAL_TZ = process.env.LOCAL_TZ || 'America/La_Paz';

  constructor(private readonly sheets: SheetsService, private readonly pdf: PdfService) {
    setInterval(() => this.cleanOldStates(), 24 * 60 * 60 * 1000);
  }

  /* ========== WhatsApp: envíos ========== */
  async sendMessage(to: string, message: string) {
    const body = { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: true, body: message } };
    const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS, timeout: 20000 });
    return data;
  }

  async sendButtons(to: string, message: string, buttons: any[]) {
    const safeButtons = buttons.slice(0, 3);
    const body = { messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: { type: 'button', body: { text: message }, action: { buttons: safeButtons } } };
    const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS, timeout: 20000 });
    return data;
  }

  async sendListMessage(to: string, message: string, buttonText: string, sections: any[]) {
    // Limitar TOTAL a 10 filas (regla de WhatsApp)
    const totalRows = sections.reduce((acc: number, s: any) => acc + (s.rows?.length || 0), 0);
    if (totalRows > 10) {
      const first = sections[0];
      first.rows = first.rows.slice(0, 10);
      sections = [first];
    }

    const body = { messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: { type: 'list', header: { type: 'text', text: 'Selecciona una opción' },
        body: { text: message }, action: { button: buttonText, sections } } };
    try {
      const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS, timeout: 20000 });
      return data;
    } catch (err: any) {
      console.error('sendListMessage error:', err?.response?.data || err);
      // fallback → 3 primeros como botones
      const simpleButtons = sections
        .flatMap((s) => s.rows.map((r: any) => ({ type: 'reply', reply: { id: r.id, title: r.title } })))
        .slice(0, 3);
      return this.sendButtons(to, message, simpleButtons);
    }
  }

  // Mantengo estas por si vuelves a adjuntar más adelante en otros flujos
  async uploadMediaToWhatsApp(buffer: Buffer, filename: string, mime = 'application/pdf'): Promise<string> {
    const form = new FormData();
    (form as any).append('messaging_product', 'whatsapp');
    (form as any).append('file', buffer, { filename: filename.endsWith('.pdf') ? filename : `${filename}.pdf`, contentType: mime });
    const url = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`;
    const { data } = await axios.post(url, form, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`, ...(form as any).getHeaders() },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 30000,
    });
    return data.id as string;
  }

  async sendDocumentByMediaId(to: string, mediaId: string, filename: string, caption: string) {
    const body = { messaging_product: 'whatsapp', to, type: 'document', document: { id: mediaId, caption, filename } };
    const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS, timeout: 20000 });
    return data;
  }
  async sendDocumentByLink(to: string, fileUrl: string, filename: string, caption: string) {
    const body = { messaging_product: 'whatsapp', to, type: 'document', document: { link: fileUrl, caption, filename } };
    const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS, timeout: 20000 });
    return data;
  }

  /* ========== Helpers ========== */
  private cleanOldStates() {
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    for (const [k, v] of this.userStates.entries()) if ((v.updatedAt || 0) < cutoff) this.userStates.delete(k);
    for (const [k] of this.forms.entries()) {
      const st = this.userStates.get(k);
      if (!st || (st.updatedAt || 0) < cutoff) this.forms.delete(k);
    }
  }
  private onlyDigits(s = '') { return String(s || '').replace(/[^\d]/g, ''); }
  private normalize(t = '') { return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }

  private findServiceFromText(text: string): { id: string; label: string } | null {
    const n = this.normalize(text);
    let best: { id: string; label: string; score: number } | null = null;
    for (const s of this.SERVICE_CATALOG) {
      let score = 0;
      if (n.includes(this.normalize(s.label))) score += 3;
      for (const a of s.aliases) if (n.includes(this.normalize(a))) score += 1;
      if (score > 0 && (!best || score > best.score)) best = { id: s.id, label: s.label, score };
    }
    return best ? { id: best.id, label: best.label } : null;
  }

  private todayYMD(): { y: number; m: number; day: number } {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', { timeZone: this.LOCAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date());
      const get = (t: any) => parts.find((p) => p.type === t)?.value || '';
      return { y: +get('year'), m: +get('month'), day: +get('day') };
    } catch {
      const now = new Date(); return { y: now.getFullYear(), m: now.getMonth() + 1, day: now.getDate() };
    }
  }

  /* ========== Validación de datos antes del PDF ========== */
  private validateAppointmentData(f: { data: ClientData; serviceType: string; slots: SlotOffered[] }) {
    const errors: string[] = [];
    const nombreOk = !!(f.data?.nombre && f.data.nombre.trim().split(/\s+/).length >= 2);
    const telOk = !!(f.data?.telefono && /^\d{7,12}$/.test(String(f.data.telefono)));
    const fecha = f.slots?.[0]?.date;
    const hora = f.slots?.[0]?.time;
    const servicio = f.serviceType;

    if (!servicio) errors.push('tipo de servicio');
    if (!fecha) errors.push('fecha');
    if (!hora) errors.push('hora');
    if (!nombreOk) errors.push('nombre y apellido');
    if (!telOk) errors.push('teléfono válido (7–12 dígitos)');
    // email es opcional

    return { ok: errors.length === 0, errors, fecha, hora, servicio };
  }

  /* ========== Lógica principal ========== */
  async generarRespuesta(text: string, from: string, buttonId?: string): Promise<string> {
    let us = this.userStates.get(from) || { state: 'initial' };
    us.updatedAt = Date.now();
    this.userStates.set(from, us);

    const cleanedText = (text || '').trim().toLowerCase();

    if (cleanedText.includes('cancelar')) {
      this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
      this.forms.delete(from);
      return 'Has cancelado el proceso actual. Escribe "hola" para comenzar de nuevo.';
    }
    if (cleanedText.includes('ayuda')) return this.getHelpMessage(us.state);

    // Reintento manual para mandar PDF (documento + link)
    if (/^enviar pdf$/i.test(cleanedText)) {
      try {
        const st = this.userStates.get(from);
        const f = this.forms.get(from);
        if (!st?.appointmentDate || !st?.appointmentTime || !st?.serviceType) {
          return 'No encontré tu última cita en memoria. Por favor escribe "hola" para iniciar o vuelve a agendar.';
        }
        const clientData: ClientData = f?.data || { telefono: this.onlyDigits(from) };
        const slots: SlotOffered[] = [{ date: st.appointmentDate!, time: st.appointmentTime!, row: -1, label: '' }];

        const temp = { data: clientData, serviceType: st.serviceType!, slots };
        const check = this.validateAppointmentData({ data: temp.data, serviceType: temp.serviceType, slots: temp.slots });
        if (!check.ok) return `Me faltan datos para generar el comprobante: ${check.errors.join(', ')}.`;

        await this.sendPdfDocAndLink(from, temp.data, temp.serviceType, slots[0].date, slots[0].time);
        return '';
      } catch (err: any) {
        console.error('Reintento enviar PDF error:', err?.response?.data || err);
        return 'No pude enviar el comprobante ahora. Intenta más tarde.';
      }
    }

    if (buttonId) return this.handleButtonAction(buttonId, from, us);
    if (this.forms.has(from)) return this.handleFormInput(from, text);

    switch (us.state) {
      case 'awaiting_service_type':         return this.handleServiceSelection(text, from);
      case 'awaiting_day_choice':           return 'Toca un *día* en la lista que te envié, por favor.';
      case 'awaiting_time_choice':          return 'Elige la *hora* desde la lista enviada.';
      case 'awaiting_appointment_confirmation': return this.handleAppointmentConfirmation(text, from);
      default:                               return this.handleInitialMessage(text, from);
    }
  }

  private async handleButtonAction(buttonId: string, from: string, us: UserState): Promise<string> {
    if (buttonId.startsWith('day_')) {
      return this.handleDaySelected(buttonId.substring(4), from);
    }
    if (buttonId.startsWith('slot_')) {
      const row = parseInt(buttonId.substring(5), 10);
      return this.handleSlotRowSelected(row, from);
    }

    switch (buttonId) {
      case 'servicios':
        return this.handleServiceSelection('servicios', from);

      case 'agendar_cita':
        this.userStates.set(from, { ...us, state: 'awaiting_service_type', updatedAt: Date.now() });
        return this.sendServiceOptions(from);

      case 'agendar_si':
        return this.handleAppointmentConfirmation('sí', from);

      case 'agendar_no':
        this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
        this.forms.delete(from);
        return 'De acuerdo. Si necesitas algo más, escribe "hola".';

      case 'confirm_yes':
        if (this.forms.has(from)) return this.finalizeFormConfirmation(from);
        return 'No encontré un formulario activo para confirmar. Escribe "hola" para comenzar.';

      case 'confirm_edit':
        await this.sendButtons(from, '¿Qué te gustaría *editar*?', [
          { type: 'reply', reply: { id: 'edit_nombre', title: '✏️ Nombre' } },
          { type: 'reply', reply: { id: 'edit_telefono', title: '✏️ Teléfono' } },
          { type: 'reply', reply: { id: 'edit_email', title: '✏️ Email' } },
        ]);
        return '';

      case 'edit_nombre':
      case 'edit_telefono':
      case 'edit_email': {
        const key = buttonId.replace('edit_', '') as FieldKey;
        const f = this.forms.get(from);
        if (f) {
          const idx = f.schema.findIndex((s) => s.key === key);
          if (idx >= 0) { f.idx = idx; await this.askNext(from); return ''; }
        }
        return 'No encontré el formulario activo. Escribe "hola" para comenzar de nuevo.';
      }

      default:
        if (buttonId.startsWith('serv_')) {
          const serviceType = buttonId.replace('serv_', '').replace(/_/g, ' ');
          const st = this.userStates.get(from) || { state: 'initial' };
          st.serviceType = serviceType;
          st.state = 'awaiting_day_choice';
          st.currentStep = 1; st.totalSteps = 5; st.updatedAt = Date.now();
          this.userStates.set(from, st);
          return this.sendNext7Days(from);
        }
        return 'No reconozco ese comando. Escribe "hola" para comenzar.';
    }
  }

  private async handleInitialMessage(text: string, from: string): Promise<string> {
    const t = (text || '').toLowerCase().trim();
    if (/(^|\b)(hola|buenas|hello|hi|buenos días|buenas tardes|buenas noches|inicio|empezar)(\b|$)/i.test(t)) {
      await this.sendWelcomeButtons(from);
      this.userStates.set(from, { state: 'awaiting_service_type', updatedAt: Date.now() });
      return '';
    }
    if (t.includes('gracias')) return '¡Gracias a ti! ¿Necesitas algo más? Escribe "hola" para volver al menú.';
    if (/(adiós|chao|hasta luego|bye)/i.test(t)) return '¡Hasta luego! Si necesitas algo más, escribe "hola".';

    const matched = this.findServiceFromText(t);
    if (matched) {
      const st = { state: 'awaiting_day_choice', serviceType: matched.label, currentStep: 1, totalSteps: 5, updatedAt: Date.now() } as UserState;
      this.userStates.set(from, st);
      return this.sendNext7Days(from);
    }
    return '🤔 No entendí tu mensaje. Escribe "hola" para empezar o toca *Ver servicios*.';
  }

  private getHelpMessage(currentState: string): string {
    const help: Record<string, string> = {
      initial: 'Escribe "hola" para comenzar.',
      awaiting_service_type: 'Selecciona un servicio de la lista.',
      awaiting_day_choice: 'Elige un día (sólo próximos 7 días hábiles).',
      awaiting_time_choice: 'Elige la *hora* disponible del día que seleccionaste.',
    };
    return help[currentState] || 'Escribe "hola" para comenzar o "cancelar" para reiniciar.';
  }

  private async sendWelcomeButtons(to: string) {
    await this.sendButtons(
      to,
      `👋 Bienvenido a *${COMPANY_NAME}*.\nAgenda en *2 minutos*: horarios *reales* y recibes *PDF + link* de confirmación.`,
      [
        { type: 'reply', reply: { id: 'servicios', title: '🧾 Ver servicios' } },
        { type: 'reply', reply: { id: 'agendar_cita', title: '📅 Agendar' } },
      ]
    );
  }

  private async sendServiceOptions(to: string) {
    const sections = [{
      title: 'Nuestros Servicios',
      rows: [
        { id: 'serv_Asesoría_Tributaria', title: 'Asesoría Tributaria' },
        { id: 'serv_Asesoría_Legal', title: 'Asesoría Legal' },
        { id: 'serv_Asesoría_Laboral', title: 'Asesoría Laboral' },
        { id: 'serv_Contabilidad', title: 'Contabilidad' },
        { id: 'serv_Sistemas_Informáticos', title: 'Sistemas Informáticos' },
      ],
    }];
    await this.sendListMessage(to, 'Primero, selecciona el *tipo de servicio* que necesitas:', 'Ver servicios', sections);
    return '';
  }

  private async sendNext7Days(to: string): Promise<string> {
    const days = await this.sheets.getNextWorkingDays(7); // excluye domingos/feriados
    const rows = days.map((d) => ({ id: `day_${d}`, title: d }));
    const sections = [{ title: 'Próximos 7 días hábiles', rows }];
    await this.sendListMessage(to, 'Elige el *día* de tu cita:', 'Elegir día', sections);
    return '';
  }

  private async handleServiceSelection(text: string, from: string): Promise<string> {
    if (['ver servicios', 'servicios', 'agendar cita', 'agendar_cita'].includes(text.toLowerCase().trim())) {
      return this.sendServiceOptions(from);
    }
    const matched = this.findServiceFromText(text);
    const st = this.userStates.get(from) || { state: 'awaiting_service_type' };
    st.serviceType = matched ? matched.label : text;
    st.state = 'awaiting_day_choice';
    st.currentStep = 1; st.totalSteps = 5; st.updatedAt = Date.now();
    this.userStates.set(from, st);
    return this.sendNext7Days(from);
  }

  private async handleDaySelected(dayYMD: string, from: string): Promise<string> {
    const offered = await this.sheets.getNextWorkingDays(7);
    if (!offered.includes(dayYMD)) {
      return this.sendNext7Days(from);
    }

    const st = this.userStates.get(from) || { state: 'awaiting_day_choice' };
    st.chosenDay = dayYMD;
    st.state = 'awaiting_time_choice';
    st.currentStep = 2; st.updatedAt = Date.now();
    this.userStates.set(from, st);

    const slots = await this.sheets.getSlotsForDate(dayYMD);
    if (!slots.length) {
      await this.sendMessage(from, `No hay horarios disponibles para *${dayYMD}*. Elige otro día.`);
      return this.sendNext7Days(from);
    }

    const rows = slots.map((s) => ({ id: `slot_${s.row}`, title: s.time }));
    const sections = [{ title: `Horarios para ${dayYMD}`, rows }];
    await this.sendListMessage(from, `📅 *${dayYMD}* — elige una *hora* disponible:`, 'Elegir hora', sections);
    return '';
  }

  private async handleSlotRowSelected(row: number, from: string): Promise<string> {
    const st = this.userStates.get(from);
    if (!st || !st.chosenDay) return 'Primero elige un *día* de la lista.';

    const ok = await this.sheets.reserveSlotRow(row, from, st.serviceType || '').catch(() => false);
    if (!ok) {
      await this.sendMessage(from, 'Ese horario acaba de ocuparse 😕. Aquí tienes las *horas disponibles* actualizadas:');
      const slots = await this.sheets.getSlotsForDate(st.chosenDay);
      if (!slots.length) return this.sendNext7Days(from);
      const rows = slots.map((s) => ({ id: `slot_${s.row}`, title: s.time }));
      const sections = [{ title: `Horarios para ${st.chosenDay}`, rows }];
      await this.sendListMessage(from, `📅 *${st.chosenDay}* — elige una *hora* disponible:`, 'Elegir hora', sections);
      return '';
    }

    const rSlots = await this.sheets.getSlotsForDate(st.chosenDay);
    const chosen = rSlots.find((s) => s.row === row) || { row, date: st.chosenDay, time: '', label: '' };

    st.appointmentDate = st.chosenDay;
    st.appointmentTime = chosen.time;
    st.state = 'collecting_form';
    st.currentStep = 3; st.updatedAt = Date.now();
    this.userStates.set(from, st);

    this.startForm(from, st.serviceType || 'Servicio', [chosen]);
    await this.askNext(from);
    return '';
  }

  private async handleAppointmentConfirmation(text: string, from: string): Promise<string> {
    const t = text.toLowerCase().trim();
    if (/(^|\b)(si|sí|agendar_si|sí, agendar|si, agendar)/i.test(t)) {
      const st = this.userStates.get(from) || { state: 'awaiting_appointment_confirmation' };
      st.state = 'awaiting_service_type';
      st.currentStep = 1; st.totalSteps = 5; st.updatedAt = Date.now();
      this.userStates.set(from, st);
      return this.sendServiceOptions(from);
    } else {
      this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
      this.forms.delete(from);
      return 'De acuerdo. Si necesitas algo más escribe "hola".';
    }
  }

  /* ========== Form Engine ========== */
  private startForm(from: string, serviceType: string, slots: SlotOffered[]) {
    const autofilledPhone = this.onlyDigits(from);
    this.forms.set(from, { idx: 0, data: { telefono: autofilledPhone }, schema: this.FORM_APPT, serviceType, slots, autofilledPhone });
  }

  private async askNext(from: string) {
    const f = this.forms.get(from); if (!f) return;
    const field = f.schema[f.idx]; await this.sendMessage(from, field.prompt({ autofilledPhone: f.autofilledPhone }));
  }

  private async handleFormInput(from: string, text: string): Promise<string> {
    const f = this.forms.get(from);
    if (!f) return '';

    const ntext = this.normalize(text);
    const field = f.schema[f.idx];
    let value = field.normalize ? field.normalize(text) : text;
    if (field.key === 'telefono' && ['si', 'sí', 'ok', 'confirmo'].includes(ntext)) value = f.autofilledPhone;

    const valid = field.validate(value);
    if (valid !== true) return String(valid);

    (f.data as any)[field.key] = String(value || '').trim();
    f.idx++;

    if (f.idx >= f.schema.length) {
      // Validación final ANTES de ofrecer confirmar
      const check = this.validateAppointmentData({ data: f.data, serviceType: f.serviceType, slots: f.slots });
      if (!check.ok) {
        await this.sendMessage(from, `Me faltan datos para continuar: ${check.errors.join(', ')}.`);
        // Regresar al primer campo faltante
        const order: FieldKey[] = ['nombre', 'telefono', 'email'];
        for (const k of order) {
          if ((k === 'nombre' && check.errors.includes('nombre y apellido'))
            || (k === 'telefono' && check.errors.includes('teléfono válido (7–12 dígitos)'))) {
            f.idx = f.schema.findIndex(s => s.key === k);
            if (f.idx >= 0) { await this.askNext(from); }
            return '';
          }
        }
        // Si el faltante es de fecha/hora/servicio (algo raro), reiniciar a selección de servicio
        const st = this.userStates.get(from) || { state: 'initial' };
        st.state = 'awaiting_service_type'; st.updatedAt = Date.now();
        this.userStates.set(from, st);
        return 'Volvamos a elegir el servicio para continuar.';
      }

      const resumen =
        `📋 *Revisa tu solicitud:*\n\n` +
        `🧾 *Servicio:* ${f.serviceType}\n` +
        `📅 *Fecha:* ${f.slots[0]?.date}\n` +
        `🕒 *Hora:* ${f.slots[0]?.time}\n\n` +
        `👤 *Nombre:* ${f.data.nombre}\n` +
        `📞 *Teléfono:* ${f.data.telefono}\n` +
        `✉️ *Email:* ${f.data.email || '—'}\n\n` +
        `¿Confirmas para guardar en agenda?`;
      await this.sendButtons(from, resumen, [
        { type: 'reply', reply: { id: 'confirm_yes', title: '✅ Confirmar' } },
        { type: 'reply', reply: { id: 'confirm_edit', title: '✏️ Editar' } },
      ]);
      return '';
    }

    await this.askNext(from);
    return '';
  }

  private async finalizeFormConfirmation(from: string): Promise<string> {
    const f = this.forms.get(from);
    const st = this.userStates.get(from);
    if (!f || !st) return 'No tengo registro de tu solicitud. Escribe "hola" para comenzar.';

    // Validación dura antes de guardar/generar
    const check = this.validateAppointmentData({ data: f.data, serviceType: f.serviceType, slots: f.slots });
    if (!check.ok) {
      await this.sendMessage(from, `Me faltan datos para continuar: ${check.errors.join(', ')}.`);
      // volver a capturar el primer campo faltante crítico
      const order: FieldKey[] = ['nombre', 'telefono', 'email'];
      for (const k of order) {
        if ((k === 'nombre' && check.errors.includes('nombre y apellido'))
          || (k === 'telefono' && check.errors.includes('teléfono válido (7–12 dígitos)'))) {
          const idx = f.schema.findIndex(s => s.key === k);
          if (idx >= 0) { f.idx = idx; await this.askNext(from); }
          return '';
        }
      }
      const ust = this.userStates.get(from) || { state: 'initial' };
      ust.state = 'awaiting_service_type'; ust.updatedAt = Date.now();
      this.userStates.set(from, ust);
      return 'Volvamos a elegir el servicio para continuar.';
    }

    // Guarda en planilla
    try {
      await this.sheets.appendAppointmentRow({
        telefono: f.data.telefono!, nombre: f.data.nombre!, email: f.data.email || '',
        servicio: f.serviceType || 'Sin especificar',
        fecha: f.slots[0].date, hora: f.slots[0].time, slotRow: f.slots[0].row,
      });
    } catch (err: any) {
      console.error('appendAppointmentRow error:', err?.response?.data || err);
      return 'Ocurrió un problema al guardar tu cita. Intenta nuevamente más tarde o llama al +591 65900645.';
    }

    await this.sendMessage(
      from,
      `✅ *¡Cita confirmada!*\n\nGracias por agendar con *${COMPANY_NAME}*.\n` +
      `Te esperamos el ${f.slots[0].date} a las ${f.slots[0].time}.\n\nGenerando tu comprobante…`
    );

    // Enviar PDF como DOCUMENTO y además Link (si S3)
    try {
      await this.sendPdfDocAndLink(from, f.data, f.serviceType, f.slots[0].date, f.slots[0].time);
    } catch (err: any) {
      console.error('PDF total error:', err?.response?.data || err);
      await this.sendMessage(from, 'Tu cita fue confirmada ✅, pero no pude enviar el comprobante. Responde "enviar pdf" para reintentarlo.');
    }

    this.forms.delete(from);
    this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
    return '¿Necesitas algo más? Escribe "hola" para volver al menú.';
  }

  /** Genera PDF una vez, intenta subir a S3 para link y subir a WhatsApp como documento. */
  private async sendPdfDocAndLink(
    to: string,
    clientData: ClientData,
    serviceType: string,
    date: string,
    time: string,
  ) {
    // 1) Generar
    const { buffer, filename } = await this.pdf.generateConfirmationPDFBuffer({
      clientData, serviceType, appointmentDate: date, appointmentTime: time,
    });

    let url: string | null = null;

    // 2) Intentar link (si S3)
    if (this.pdf.isS3Enabled()) {
      try {
        url = await this.pdf.uploadToS3(buffer, filename, 'application/pdf');
      } catch (err: any) {
        console.error('uploadToS3 error:', err?.response?.data || err);
      }
    }

    // 3) Intentar documento por mediaId
    let mediaOk = false;
    try {
      const mediaId = await this.uploadMediaToWhatsApp(buffer, filename, 'application/pdf');
      await this.sendDocumentByMediaId(to, mediaId, filename, `Comprobante de cita - ${COMPANY_NAME}`);
      mediaOk = true;
    } catch (err: any) {
      console.error('uploadMedia/sendDocument error:', err?.response?.data || err);
    }

    // 4) Si tenemos URL, mandarla SIEMPRE (complemento o fallback)
    if (url) {
      await this.sendMessage(to, `🔗 *Tu comprobante en PDF:*\n${url}`);
    } else if (!mediaOk) {
      // Si no hay media ni url:
      await this.sendMessage(to, 'No pude adjuntar ni generar el link del comprobante. Responde "enviar pdf" para reintentar.');
    }
  }
}
