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
  lastOfferedSlots?: SlotOffered[];
  slotsPage?: number;
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

  // === FORM: Email ahora es OBLIGATORIO, y se mejora validación de nombre/teléfono ===
  private readonly FORM_APPT: FormField[] = [
    {
      key: 'nombre',
      prompt: () => '🧍‍♀️ *Paso 1/3*: ¿Cuál es tu *nombre y apellido*?',
      validate: (v) => {
        const val = String(v || '').trim();
        // Solo letras (con acentos) y espacios, mínimo dos palabras de 2+ letras
        if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]+$/.test(val)) return 'Usa solo letras y espacios (ej. María González).';
        const parts = val.split(/\s+/).filter(Boolean);
        if (parts.length < 2 || parts.some(p => p.length < 2)) return 'Escribe nombre y apellido (ej. María González).';
        return true;
      },
    },
    {
      key: 'telefono',
      prompt: (ctx) =>
        `📞 *Paso 2/3*: ¿Confirmas este *número* para contactarte: *${ctx.autofilledPhone}*?\n\nResponde con:\n• *sí* para usarlo\n• O escribe otro número (8 dígitos; se admite +591)`,
      validate: (v) => {
        const digits = String(v || '').replace(/[^\d]/g, '');
        const normalized = digits.startsWith('591') ? digits.slice(3) : digits;
        if (!/^\d{8}$/.test(normalized)) return 'Número inválido. Usa 8 dígitos (ej. 65900645).';
        return true;
      },
      normalize: (v) => {
        const digits = String(v || '').replace(/[^\d]/g, '');
        const normalized = digits.startsWith('591') ? digits.slice(3) : digits;
        return normalized;
      },
    },
    {
      key: 'email',
      prompt: () => '✉️ *Paso 3/3*: ¿Cuál es tu *email* para enviarte la confirmación?',
      validate: (v) => {
        const val = String(v || '').trim().toLowerCase();
        // Regex sólida pero razonable (no RFC completa)
        return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(val) || 'Email inválido (ej. nombre@ejemplo.com).';
      },
      normalize: (v) => String(v || '').trim().toLowerCase(),
    },
  ];

  private readonly LOCAL_TZ = process.env.LOCAL_TZ || 'America/La_Paz';

  constructor(private readonly sheets: SheetsService, private readonly pdf: PdfService) {
    setInterval(() => this.cleanOldStates(), 24 * 60 * 60 * 1000);
  }

  /* ========== WhatsApp: envíos ========== */
  async sendMessage(to: string, message: string) {
    const body = { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: false, body: message } };
    const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
    return data;
  }

  async sendButtons(to: string, message: string, buttons: any[]) {
    const safeButtons = buttons.slice(0, 3);
    const body = { messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: { type: 'button', body: { text: message }, action: { buttons: safeButtons } } };
    const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
    return data;
  }

  async sendListMessage(to: string, message: string, buttonText: string, sections: any[]) {
    // WhatsApp Cloud API: máx 10 filas total (no solo por sección). Paginamos externamente.
    const body = { messaging_product: 'whatsapp', to, type: 'interactive',
      interactive: { type: 'list', header: { type: 'text', text: 'Selecciona una opción' },
        body: { text: message }, action: { button: buttonText, sections } } };
    try {
      const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return data;
    } catch (e: any) {
      // fallback → 3 primeros como botones
      const simpleButtons = sections.flatMap((s) => s.rows.map((r: any) => ({ type: 'reply', reply: { id: r.id, title: r.title } }))).slice(0, 3);
      return this.sendButtons(to, message, simpleButtons);
    }
  }

  async uploadMediaToWhatsApp(buffer: Buffer, filename: string, mime = 'application/pdf'): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', buffer, { filename, contentType: mime });
    const url = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`;
    const { data } = await axios.post(url, form, { headers: { Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`, ...form.getHeaders() } });
    return data.id as string;
  }

  async sendDocumentByMediaId(to: string, mediaId: string, filename: string, caption: string) {
    const body = { messaging_product: 'whatsapp', to, type: 'document', document: { id: mediaId, caption, filename } };
    const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
    return data;
  }
  async sendDocumentByLink(to: string, fileUrl: string, filename: string, caption: string) {
    const body = { messaging_product: 'whatsapp', to, type: 'document', document: { link: fileUrl, caption, filename } };
    const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
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

  /* ========== Paginación de horarios (máx 10 filas totales por mensaje) ========== */
  private buildSlotPages(slots: SlotOffered[], pageSize = 9): SlotOffered[][] {
    const pages: SlotOffered[][] = [];
    for (let i = 0; i < slots.length; i += pageSize) pages.push(slots.slice(i, i + pageSize));
    return pages;
  }

  private async sendSlotsPaged(to: string, dayYMD: string, slots: SlotOffered[], pageIdx = 0) {
    const pages = this.buildSlotPages(slots, 9); // 9 filas + 1 "Siguiente"
    const safePage = Math.max(0, Math.min(pageIdx, pages.length - 1));
    const page = pages[safePage] || [];

    const rows = page.map((s) => ({ id: `slot_${s.row}`, title: s.time }));
    if (pages.length > 1 && safePage < pages.length - 1) {
      rows.push({ id: `more_${safePage + 1}`, title: 'Siguiente ▷' });
    }
    if (pages.length > 1 && safePage > 0) {
      // opcional: permitir volver atrás añadiendo “◁ Anterior” (usa una fila)
      rows.unshift({ id: `more_${safePage - 1}`, title: '◁ Anterior' });
      // nos mantenemos <=10 filas: si agregamos “Anterior”, quitamos el último horario si hace falta
      if (rows.length > 10) rows.splice(rows.length - 2, 1);
    }

    await this.sendListMessage(
      to,
      `📅 *${dayYMD}* — elige una *hora* disponible:${pages.length > 1 ? `\n(Página ${safePage + 1}/${pages.length})` : ''}`,
      'Elegir hora',
      [{ title: `Horarios para ${dayYMD}`, rows }]
    );
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

    if (buttonId) return this.handleButtonAction(buttonId, from, us);
    if (this.forms.has(from)) return this.handleFormInput(from, text);

    switch (us.state) {
      case 'awaiting_service_type':         return this.handleServiceSelection(text, from);
      case 'awaiting_day_choice':           return 'Selecciona un *día* desde la lista que te envié.';
      case 'awaiting_time_choice':          return 'Elige una *hora* desde la lista enviada.';
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
    if (buttonId.startsWith('more_')) {
      // Navegación de páginas de horarios
      const idx = parseInt(buttonId.substring(5), 10) || 0;
      const st = this.userStates.get(from);
      if (!st?.chosenDay || !st.lastOfferedSlots?.length) return 'Primero elige un *día* de la lista.';
      st.slotsPage = idx;
      this.userStates.set(from, st);
      await this.sendSlotsPaged(from, st.chosenDay, st.lastOfferedSlots, idx);
      return '';
    }

    switch (buttonId) {
      case 'servicios':
        return this.handleServiceSelection('servicios', from);

      // 🚫 Bloqueo de “Agendar” directo: se exige elegir servicio primero
      case 'agendar_cita':
        this.userStates.set(from, { ...us, state: 'awaiting_service_type', updatedAt: Date.now() });
        await this.sendMessage(from, 'Para agendar, primero elige el *tipo de servicio*.');
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
      awaiting_time_choice: 'Elige la hora disponible del día que seleccionaste.',
    };
    return help[currentState] || 'Escribe "hola" para comenzar o "cancelar" para reiniciar.';
  }

  // 🔒 Quita el botón de “Agendar” directo. Solo se muestra “Ver servicios”.
  private async sendWelcomeButtons(to: string) {
    await this.sendButtons(
      to,
      `👋 Bienvenido a *${COMPANY_NAME}*.\nPara agendar, primero elige el *tipo de servicio*.`,
      [
        { type: 'reply', reply: { id: 'servicios', title: '🧾 Ver servicios' } },
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
    const days = await this.sheets.getNextWorkingDays(7); // excluye domingos y feriados
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
    // valida que esté dentro de los 7 días ofrecidos
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

    // Guardamos horarios y mostramos primera página (lista, no botones)
    st.lastOfferedSlots = slots;
    st.slotsPage = 0;
    this.userStates.set(from, st);

    await this.sendSlotsPaged(from, dayYMD, slots, 0);
    return '';
  }

  private async handleSlotRowSelected(row: number, from: string): Promise<string> {
    const st = this.userStates.get(from);
    if (!st || !st.chosenDay) return 'Primero elige un *día* de la lista.';

    // Verifica de nuevo disponibilidad y reserva atómica (con servicio)
    const ok = await this.sheets.reserveSlotRow(row, from, st.serviceType || '').catch(() => false);
    if (!ok) {
      await this.sendMessage(from, 'Ese horario acaba de ocuparse 😕. Aquí tienes las *horas disponibles* actualizadas:');
      const slots = await this.sheets.getSlotsForDate(st.chosenDay);
      if (!slots.length) return this.sendNext7Days(from);
      st.lastOfferedSlots = slots; st.slotsPage = 0; this.userStates.set(from, st);
      await this.sendSlotsPaged(from, st.chosenDay, slots, 0);
      return '';
    }

    // Guarda selección y pasa a formulario
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
    const digits = this.onlyDigits(from);
    const normalized = digits.startsWith('591') ? digits.slice(3) : digits;
    this.forms.set(from, { idx: 0, data: { telefono: normalized }, schema: this.FORM_APPT, serviceType, slots, autofilledPhone: normalized });
  }
  private async askNext(from: string) {
    const f = this.forms.get(from); if (!f) return;
    const field = f.schema[f.idx]; await this.sendMessage(from, field.prompt({ autofilledPhone: f.autofilledPhone }));
  }
  private async handleFormInput(from: string, text: string): Promise<string> {
    const f = this.forms.get(from); if (!f) return '';

    const ntext = this.normalize(text);
    const field = f.schema[f.idx];
    let value = field.normalize ? field.normalize(text) : text;
    if (field.key == 'telefono' && ['si', 'sí', 'ok', 'confirmo'].includes(ntext)) value = f.autofilledPhone;

    const valid = field.validate(value);
    if (valid !== true) return String(valid);

    (f.data as any)[field.key] = String(value || '').trim();
    f.idx++;

    if (f.idx >= f.schema.length) {
      const resumen =
        `📋 *Revisa tu solicitud:*\n\n` +
        `🧾 *Servicio:* ${f.serviceType}\n` +
        `📅 *Fecha:* ${f.slots[0]?.date}\n` +
        `🕒 *Hora:* ${f.slots[0]?.time}\n\n` +
        `👤 *Nombre:* ${f.data.nombre}\n` +
        `📞 *Teléfono:* ${f.data.telefono}\n` +
        `✉️ *Email:* ${f.data.email}\n\n` +
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

    try {
      await this.sheets.appendAppointmentRow({
        telefono: f.data.telefono!, nombre: f.data.nombre!, email: f.data.email!,
        servicio: f.serviceType || 'Sin especificar',
        fecha: f.slots[0].date, hora: f.slots[0].time, slotRow: f.slots[0].row,
      });
    } catch {
      return 'Ocurrió un problema al guardar tu cita. Intenta nuevamente más tarde o llama al +591 65900645.';
    }

    await this.sendMessage(from,
      `✅ *¡Cita confirmada!*\n\nGracias por agendar con *${COMPANY_NAME}*.\n` +
      `Te esperamos el ${f.slots[0].date} a las ${f.slots[0].time}.\n\nSi necesitas cancelar o reprogramar, contáctanos al +591 65900645.`
    );

    try {
      const { buffer, filename } = await this.pdf.generateConfirmationPDFBuffer({
        clientData: f.data, serviceType: f.serviceType, appointmentDate: f.slots[0].date, appointmentTime: f.slots[0].time,
      });
      let sentOk = false;
      if (this.pdf.isS3Enabled()) {
        try {
          const url = await this.pdf.uploadToS3(buffer, filename, 'application/pdf');
          await this.sendDocumentByLink(from, url, filename, `Comprobante de cita - ${COMPANY_NAME}`);
          sentOk = true;
        } catch {}
      }
      if (!sentOk) {
        const mediaId = await this.uploadMediaToWhatsApp(buffer, filename, 'application/pdf');
        await this.sendDocumentByMediaId(from, mediaId, filename, `Comprobante de cita - ${COMPANY_NAME}`);
      }
    } catch {}

    this.forms.delete(from);
    this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
    return '¿Necesitas algo más? Escribe "hola" para volver al menú.';
  }
}
