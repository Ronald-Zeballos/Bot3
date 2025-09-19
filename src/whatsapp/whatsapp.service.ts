import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as FormData from 'form-data';
import { SheetsService, SlotOffered } from '../sheets/sheets.service';
import { PdfService } from '../pdf/pdf.service';

const COMPANY_NAME = 'Russell Bedford Bolivia Encinas Auditores y Consultores SRL';
const COMPANY_PHONE_E164 = '+59170400175'; // para vCard temporal
const COMPANY_HOURS_TEXT = 'Nuestro horario de atención es de *Lunes a Viernes* de *08:00–12:00 y 14:30–18:30*';
const COMPANY_MAPS_URL = 'https://maps.app.goo.gl/TU82fjJzHG3RBAbTA';
const COMPANY_LOCATION_TEXT = 'Nuestra ubicación es: \n 📍 Russell Bedford Bolivia – Encinas Auditores y Consultores SRL\n' + COMPANY_MAPS_URL;

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
    private async sendMainMenuList(to: string) {
      const sections = [{
        title: 'Menú principal',
        rows: [
          { id: 'ver_servicios', title: '🧾 Ver servicios' },
          { id: 'agendar_cita',  title: '📅 Agendar cita' },
          { id: 'hablar_asesor', title: '👤 Hablar con asesor' },
          { id: 'horario',       title: '🕒 Horario' },
          { id: 'ubicacion',     title: '📍 Ubicación' },
        ],
      }];
      await this.sendListMessage(
        to,
        '¿En qué te puedo ayudar?',
        'Abrir menú',
        sections
      );
      return '';
    }

  // Áreas para "Hablar con asesor" (por ahora todos al mismo número)
  private readonly ADVISOR_AREAS = [
    { id: 'area_tributario', title: 'Tributario', name: 'Asesor de Tributario', phone: COMPANY_PHONE_E164 },
    { id: 'area_legal',      title: 'Legal',      name: 'Asesor de Legal',      phone: COMPANY_PHONE_E164 },
    { id: 'area_laboral',    title: 'Laboral',    name: 'Asesor de Laboral',    phone: COMPANY_PHONE_E164 },
    { id: 'area_conta',      title: 'Contabilidad', name: 'Asesor de Contabilidad', phone: COMPANY_PHONE_E164 },
    { id: 'area_sistemas',   title: 'Sistemas',   name: 'Asesor de Sistemas',   phone: COMPANY_PHONE_E164 },
  ];

  private userStates = new Map<string, UserState>();
  private forms = new Map<
    string,
    {
      idx: number;
      data: ClientData;
      schema: FormField[];
      serviceType: string;
      slots: SlotOffered[];
      autofilledPhone: string;
      awaitingPhoneManual?: boolean; // ← si elige "No" en confirmar teléfono
    }
  >();

  // === FORM ===
  private readonly FORM_APPT: FormField[] = [
    {
      key: 'nombre',
      prompt: () => 'Para agendar tu cita ¿Cuál es tu *nombre y apellido*?',
      validate: (v) => {
        const val = String(v || '').trim();
        if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]+$/.test(val)) return 'Usa solo letras y espacios (ej. María González).';
        const parts = val.split(/\s+/).filter(Boolean);
        if (parts.length < 2 || parts.some((p) => p.length < 2)) return 'Escribe nombre y apellido (ej. María González).';
        return true;
      },
    },
    {
      key: 'telefono',
      prompt: (ctx) =>
        `Muchas gracias, ¿Confirmas este *número* para contactarte: *${ctx.autofilledPhone}*?`,
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
      prompt: () => '¿Cuál es tu *email* para enviarte la confirmación?',
      validate: (v) => {
        const val = String(v || '').trim().toLowerCase();
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
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: { type: 'button', body: { text: message }, action: { buttons: safeButtons } },
    };
    const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
    return data;
  }

  async sendListMessage(to: string, message: string, buttonText: string, sections: any[]) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'interactive',
      interactive: {
        type: 'list',
        header: { type: 'text', text: 'Selecciona una opción' },
        body: { text: message },
        action: { button: buttonText, sections },
      },
    };
    try {
      const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return data;
    } catch {
      const simpleButtons = sections
        .flatMap((s) => s.rows.map((r: any) => ({ type: 'reply', reply: { id: r.id, title: r.title } })))
        .slice(0, 3);
      return this.sendButtons(to, message, simpleButtons);
    }
  }

  // Enviar un contacto (vCard) — WhatsApp Cloud API "contacts"
  async sendContact(to: string, fullName: string, phoneE164: string) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'contacts',
      contacts: [
        {
          name: { formatted_name: fullName, first_name: fullName },
          phones: [{ phone: phoneE164, type: 'CELL', wa_id: phoneE164.replace(/[^\d]/g, '') }],
        },
      ],
    };
    try {
      const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return data;
    } catch {
      // Fallback: solo texto
      return this.sendMessage(to, `📇 ${fullName}\n📞 ${phoneE164}`);
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

  /* ========== Paginación de horarios ========== */
  private buildSlotPages(slots: SlotOffered[], pageSize = 9): SlotOffered[][] {
    const pages: SlotOffered[][] = [];
    for (let i = 0; i < slots.length; i += pageSize) pages.push(slots.slice(i, i + pageSize));
    return pages;
  }

  private async sendSlotsPaged(to: string, dayYMD: string, slots: SlotOffered[], pageIdx = 0) {
    const pages = this.buildSlotPages(slots, 9);
    const safePage = Math.max(0, Math.min(pageIdx, pages.length - 1));
    const page = pages[safePage] || [];

    const rows = page.map((s) => ({ id: `slot_${s.row}`, title: s.time }));
    if (pages.length > 1 && safePage < pages.length - 1) rows.push({ id: `more_${safePage + 1}`, title: 'Siguiente ▷' });
    if (pages.length > 1 && safePage > 0) {
      rows.unshift({ id: `more_${safePage - 1}`, title: '◁ Anterior' });
      if (rows.length > 10) rows.splice(rows.length - 2, 1);
    }

    await this.sendListMessage(
      to,
      `📅 *${dayYMD}* — elige una *hora* disponible:${pages.length > 1 ? `\n(Página ${safePage + 1}/${pages.length})` : ''}`,
      'Elegir hora',
      [{ title: `Horarios para ${dayYMD}`, rows }]
    );
  }

  /* ========== Bloques de mensajes cortos ========== */
  private async sendHours(to: string) {
    return this.sendMessage(to, COMPANY_HOURS_TEXT);
  }

  private async sendLocation(to: string) {
    return this.sendMessage(to, COMPANY_LOCATION_TEXT);
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
    // Día/Hora
    if (buttonId.startsWith('day_')) return this.handleDaySelected(buttonId.substring(4), from);
    if (buttonId.startsWith('slot_')) return this.handleSlotRowSelected(parseInt(buttonId.substring(5), 10), from);
    if (buttonId.startsWith('more_')) {
      const idx = parseInt(buttonId.substring(5), 10) || 0;
      const st = this.userStates.get(from);
      if (!st?.chosenDay || !st.lastOfferedSlots?.length) return 'Primero elige un *día* de la lista.';
      st.slotsPage = idx; this.userStates.set(from, st);
      await this.sendSlotsPaged(from, st.chosenDay, st.lastOfferedSlots, idx);
      return '';
    }

    // Confirmación de teléfono
    if (buttonId === 'tel_yes' || buttonId === 'tel_no') {
      const f = this.forms.get(from);
      if (!f) return '';
      if (buttonId === 'tel_yes') {
        // usar el autofilled y avanzar
        (f.data as any)['telefono'] = f.autofilledPhone;
        f.awaitingPhoneManual = false;
        f.idx++;
        this.forms.set(from, f);
        await this.askNext(from);
        return '';
      } else {
        // pedirlo manualmente
        f.awaitingPhoneManual = true;
        this.forms.set(from, f);
        await this.sendMessage(from, 'Por favor, escribe tu *número de 8 dígitos* (se admite con o sin +591).');
        return '';
      }
    }

    switch (buttonId) {
      case 'inicio':
        this.userStates.set(from, { state: 'awaiting_service_type', updatedAt: Date.now() });
        await this.sendWelcomeButtons(from);
        return '';

      case 'ver_servicios':
        await this.sendServiceOptions(from);    // lista completa
        // botones de Inicio / Agendar
        await this.sendButtons(from, '¿Qué deseas hacer ahora?', [
          { type: 'reply', reply: { id: 'inicio', title: '🏠 Inicio' } },
          { type: 'reply', reply: { id: 'agendar_cita', title: '📅 Agendar Cita' } },
        ]);
        return '';

      case 'agendar_cita':
        this.userStates.set(from, { ...us, state: 'awaiting_service_type', updatedAt: Date.now() });
        await this.sendMessage(from, 'Para agendar, primero elige el *tipo de servicio*.');
        return this.sendServiceOptions(from);

      case 'hablar_asesor': {
        const rows = this.ADVISOR_AREAS.map((a) => ({ id: a.id, title: a.title }));
        await this.sendListMessage(from, '¿Con qué *área* quieres hablar?', 'Elegir área', [{ title: 'Áreas', rows }]);
        return '';
      }

      case 'horario':
        await this.sendHours(from);
        return '';

      case 'ubicacion':
        await this.sendLocation(from);
        return '';

      // Edición de formulario
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

      default: {
        // Toca un servicio por botón
        if (buttonId.startsWith('serv_')) {
          const serviceType = buttonId.replace('serv_', '').replace(/_/g, ' ');
          const st = this.userStates.get(from) || { state: 'initial' };
          st.serviceType = serviceType;
          st.state = 'awaiting_day_choice';
          st.currentStep = 1; st.totalSteps = 5; st.updatedAt = Date.now();
          this.userStates.set(from, st);
          return this.sendNext7Days(from);
        }
        // Área para asesor
        if (buttonId.startsWith('area_')) {
          const area = this.ADVISOR_AREAS.find((a) => a.id === buttonId);
          if (!area) return 'Área no reconocida.';
          await this.sendMessage(from, `Te comparto el contacto del *${area.name}* 👇`);
          await this.sendContact(from, area.name, area.phone);
          return '';
        }
        return 'No reconozco ese comando. Escribe "hola" para comenzar.';
      }
    }
  }

  private async handleInitialMessage(text: string, from: string): Promise<string> {
    const t = (text || '').toLowerCase().trim();
    if (/(^|\b)(hola|buenas|hello|hi|buenos días|buenas tardes|buenas noches|inicio|empezar)(\b|$)/i.test(t)) {
      // 1) Mensaje de bienvenida
      await this.sendMessage(
        from,
        `Hola, soy el *Asistente Virtual* de *${COMPANY_NAME}*.`
      );

    await this.sendMainMenuList(from);


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

  private async sendWelcomeButtons(to: string) {
    // Conservamos compat y mostramos sólo “Ver servicios” en este helper
    await this.sendButtons(
      to,
      `👋 Bienvenido a *${COMPANY_NAME}*.\nPara agendar, primero elige el *tipo de servicio*.`,
      [{ type: 'reply', reply: { id: 'ver_servicios', title: '🧾 Ver servicios' } }]
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
    await this.sendListMessage(to, 'Selecciona el *tipo de servicio* que necesitas:', 'Ver servicios', sections);
    return '';
  }

  private async sendNext7Days(to: string): Promise<string> {
    const days = await this.sheets.getNextWorkingDays(7);
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
    if (!offered.includes(dayYMD)) return this.sendNext7Days(from);

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

    st.lastOfferedSlots = slots;
    st.slotsPage = 0;
    this.userStates.set(from, st);

    await this.sendSlotsPaged(from, dayYMD, slots, 0);
    return '';
  }

  private async handleSlotRowSelected(row: number, from: string): Promise<string> {
  const st = this.userStates.get(from);
  if (!st || !st.chosenDay) return 'Primero elige un *día* de la lista.';

  // 👈 Toma el horario ELEGIDO antes de reservar (porque luego ya no aparece como DISPONIBLE)
  const chosenFromState =
    st.lastOfferedSlots?.find((s) => s.row === row) ||
    null;

  // Reserva atómica
  const ok = await this.sheets.reserveSlotRow(row, from, st.serviceType || '').catch(() => false);
  if (!ok) {
    await this.sendMessage(from, 'Ese horario acaba de ocuparse 😕. Aquí tienes las *horas disponibles* actualizadas:');
    const slots = await this.sheets.getSlotsForDate(st.chosenDay);
    if (!slots.length) return this.sendNext7Days(from);
    st.lastOfferedSlots = slots; st.slotsPage = 0; this.userStates.set(from, st);
    await this.sendSlotsPaged(from, st.chosenDay, slots, 0);
    return '';
  }

  const chosen = chosenFromState || { row, date: st.chosenDay, time: '', label: '' };

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
    this.forms.set(from, {
      idx: 0,
      data: { telefono: normalized },
      schema: this.FORM_APPT,
      serviceType,
      slots,
      autofilledPhone: normalized,
      awaitingPhoneManual: false,
    });
  }

  private async askNext(from: string) {
    const f = this.forms.get(from); if (!f) return;
    const field = f.schema[f.idx];

    // Paso especial para teléfono: enviamos botones Sí/No
    if (field.key === 'telefono' && !f.awaitingPhoneManual) {
      const msg = field.prompt({ autofilledPhone: f.autofilledPhone }) + '\n\nElige una opción:';
      await this.sendButtons(from, msg, [
        { type: 'reply', reply: { id: 'tel_yes', title: 'Sí, usar este' } },
        { type: 'reply', reply: { id: 'tel_no', title: 'No, ingresar otro' } },
      ]);
      return;
    }

    await this.sendMessage(from, field.prompt({ autofilledPhone: f.autofilledPhone }));
  }

  private async handleFormInput(from: string, text: string): Promise<string> {
    const f = this.forms.get(from); if (!f) return '';

    const field = f.schema[f.idx];

    // Si estamos esperando teléfono manual
    if (field.key === 'telefono' && f.awaitingPhoneManual) {
      const valid = field.validate(text);
      if (valid !== true) return String(valid);
      const normalized = field.normalize ? field.normalize(text) : text;
      (f.data as any)[field.key] = String(normalized || '').trim();
      f.awaitingPhoneManual = false;
      f.idx++;
      this.forms.set(from, f);
      await this.askNext(from);
      return '';
    }

    // Flujo normal
    let value = field.normalize ? field.normalize(text) : text;
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
        } catch (e){
          console.error('Error subiendo a S3 o enviando por link:', (e as any)?.response?.data || e);
        }
      }

       if (!sentOk) {
          try {
            const mediaId = await this.uploadMediaToWhatsApp(buffer, filename, 'application/pdf');
            await this.sendDocumentByMediaId(from, mediaId, filename, `Comprobante de cita - ${COMPANY_NAME}`);
            sentOk = true;
          } catch (e) {
            console.error('Error subiendo/enviando PDF por mediaId:', (e as any)?.response?.data || e);
          }
        }

        if (!sentOk) {
          await this.sendMessage(from, 'No pude adjuntar el PDF ahora mismo. Te lo reenviaré en breve o puedes solicitarlo respondiendo "enviar pdf".');
        }
      } catch (e) {
        console.error('Error generando el PDF:', (e as any)?.message || e);
      }

    this.forms.delete(from);
    this.userStates.set(from, { state: 'initial', updatedAt: Date.now() });
    return '¿Necesitas algo más? Escribe "hola" para volver al menú.';
  }
}
