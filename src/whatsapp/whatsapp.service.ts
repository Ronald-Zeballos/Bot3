import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as FormData from 'form-data';
import { SheetsService } from '../sheets/sheets.service';
import { PdfService } from '../pdf/pdf.service';

/** =========================
 *  Config Ace Hardware (chat)
 *  ========================= */
const ACE_NAME = 'Ace Hardware';
const ACE_GREETING =
  '¡Hola! Bienvenido a Ace Hardware 💪\n¿En qué te podemos ayudar el día de hoy?';

const BTN_HOME = { type: 'reply', reply: { id: 'home', title: '🏠 Menú Principal' } };
const BTN_BACK = { type: 'reply', reply: { id: 'back', title: '🔙 Menú Anterior' } };

/** Links y textos del flujo */
const ATENCION_SUCURSALES = [
  { id: 'suc_banzer',        title: '✅ Suc. Av. Banzer 5to y 6to anillo', link: 'https://wa.link/7i0euc' },
  { id: 'suc_doble_via',     title: '✅ Suc. Av. Doble vía la guardia 5to', link: 'https://wa.link/g4a1a7' },
  { id: 'suc_virgen_cotoca', title: '✅ Suc. Av. Virgen de Cotoca 4to y 5to', link: 'https://wa.link/08g18a' },
];

const MINI_CUOTAS = [
  { id: 'mc_banzer',     title: 'Ej. Suc. Banzer 5to y 6to anillo', link: 'https://wa.link/ez2y4f' },
  { id: 'mc_doble_via',  title: 'Ej. Suc. Doble vía 5to anillo',    link: 'https://wa.link/w8e6f3' },
  { id: 'mc_requisitos', title: 'Requisitos Mini Cuotas',           link: 'https://www.dismac.com.bo/minicuotas.html' },
];

const COTIZACION_EMPRESAS = [
  { id: 'emp_asesor1', title: 'Asesor1', link: 'https://wa.link/w06z6f' },
  { id: 'emp_asesor2', title: 'Asesor2', link: 'https://wa.link/c7c0nb' },
];

const DIRECCIONES_HORARIOS =
  'Visítanos en nuestras 3 sucursales:\n' +
  '📍 Av. Banzer, entre 5to y 6to anillo.\n' +
  '   Ubicación: http://bit.ly/3RKFcy2\n\n' +
  '📍 Av. Doble Vía La Guardia, entre 5to y 6to anillo.\n' +
  '   Ubicación: https://bit.ly/UbicacionDobleVia\n\n' +
  '📍 Av. Virgen de Cotoca, entre 4to y 5to anillo.\n' +
  '   Ubicación: https://bit.ly/UbicacionVirgenDeCotoca\n\n' +
  '🕥 Lunes a Viernes: 7:30 - 21:00 hrs\n' +
  '🕥 Sábado y Domingo: 8:30 - 20:30 hrs';

const TRABAJO_COMUNIDAD = [
  { id: 'wrk_proveedor', title: '✅ Ser proveedor o trabajar con nosotros', text: 'Envíanos un correo ✉ contacto@acebolivia.com.bo' },
  { id: 'wrk_canal',     title: '✅ Únete a nuestro canal de WhatsApp 🥰',   text: 'Entérate de novedades, talleres y ofertas exclusivas aquí:\nhttps://whatsapp.com/channel/0029VbAVvdP77qVLD6SpkJ3I' },
];

/** ==========================================
 *  Compat (no tocamos PDF/Sheets existentes)
 *  ========================================== */
const COMPANY_NAME = 'Russell Bedford Bolivia Encinas Auditores y Consultores SRL';
const COMPANY_HOURS_TEXT = 'Nuestro horario de atención es de *Lunes a Viernes* de *08:00–12:00 y 14:30–18:30*';
const COMPANY_MAPS_URL = 'https://maps.app.goo.gl/TU82fjJzHG3RBAbTA';
const COMPANY_LOCATION_TEXT = 'Nuestra ubicación es: \n 📍 Russell Bedford Bolivia – Encinas Auditores y Consultores SRL\n' + COMPANY_MAPS_URL;

/* =========================
 *  Tipos de estado (FIX TS)
 * ========================= */
type NavStateName = 'home' | 'atencion' | 'minicuotas' | 'empresas' | 'direccion' | 'trabajo';

type BaseState = {
  updatedAt?: number;
  lastMenu?: NavStateName;
};

type NavState = BaseState & { state: NavStateName; };
type RegisterNameState = BaseState & { state: 'register_name'; pendingPhone: string; };
type RegisterEmailState = BaseState & { state: 'register_email'; pendingPhone: string; tempName: string; };

type UserState = NavState | RegisterNameState | RegisterEmailState;

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  private userStates = new Map<string, UserState>();

  constructor(private readonly sheets: SheetsService, private readonly pdf: PdfService) {
    setInterval(() => this.cleanOldStates(), 24 * 60 * 60 * 1000);
  }

  /* ===== Helpers de estado ===== */
  private getLastMenu(us?: UserState): NavStateName {
    return (us?.lastMenu as NavStateName) || 'home';
  }
  private setState(to: string, next: UserState) {
    const prev = this.userStates.get(to);
    if (next.lastMenu === undefined && prev?.lastMenu) next.lastMenu = prev.lastMenu;
    next.updatedAt = Date.now();
    this.userStates.set(to, next);
  }

  /* ========== WhatsApp: envíos ========== */
  async sendMessage(to: string, message: string) {
    const body = { messaging_product: 'whatsapp', to, type: 'text', text: { preview_url: true, body: message } };
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

    // WhatsApp: buttonText máx. 20 chars → si falla, caemos a botones truncados
    const toBtnTitle = (s: string) => {
      const str = String(s || '').trim();
      if (str.length <= 20) return str || 'Opción';
      return str.slice(0, 19) + '…';
    };

    try {
      const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return data;
    } catch {
      const simpleButtons = sections
        .flatMap((s) => (s.rows || []).map((r: any) => ({ type: 'reply', reply: { id: r.id, title: toBtnTitle(r.title) } })))
        .slice(0, 3);
      if (!simpleButtons.length) simpleButtons.push({ type: 'reply', reply: { id: 'home', title: 'Menú' } });
      return this.sendButtons(to, message, simpleButtons);
    }
  }

  async sendContact(to: string, fullName: string, phoneE164: string) {
    const body = {
      messaging_product: 'whatsapp',
      to,
      type: 'contacts',
      contacts: [{ name: { formatted_name: fullName, first_name: fullName }, phones: [{ phone: phoneE164, type: 'CELL', wa_id: phoneE164.replace(/[^\d]/g, '') }] }],
    };
    try {
      const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return data;
    } catch {
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
  }
  private onlyDigits(s = '') { return String(s || '').replace(/[^\d]/g, ''); }

  /** =============================
   *  Menú principal (Lista)
   *  ============================= */
  private async sendAceMainMenu(to: string, name?: string) {
    const saludo = name ? `👋 ${name}, estas son las opciones:` : 'Selecciona tu consulta escribiendo el número o tocando:';
    const sections = [{
      title: 'Menú principal',
      rows: [
        { id: 'm_atencion',   title: '1. Atención' },
        { id: 'm_minicuotas', title: '2. Mini Cuotas' },
        { id: 'm_empresas',   title: '3. Empresas' },
        { id: 'm_direccion',  title: '4. Dirección/horario' }, // 20 chars exactos
        { id: 'm_trabajo',    title: '5. Trabajo/Comunidad' }, // 20 chars exactos
      ],
    }];
    await this.sendListMessage(to, saludo, 'Abrir menú', sections);
  }

  /** =============================
   *  Submenús
   *  ============================= */
  private async sendSubmenuAtencion(to: string) {
    const rows = ATENCION_SUCURSALES.map((s) => ({ id: `atn_${s.id}`, title: s.title }));
    await this.sendListMessage(to, 'Selecciona tu sucursal:', 'Ver sucursales', [{ title: 'Atención al cliente', rows }]);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
  }
  private async sendSubmenuMiniCuotas(to: string) {
    const rows = MINI_CUOTAS.map((m) => ({ id: `mc_${m.id}`, title: m.title }));
    await this.sendListMessage(to, 'Selecciona tu ejecutivo o ver requisitos:', 'Ver opciones', [{ title: 'Mini Cuotas', rows }]);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
  }
  private async sendEmpresas(to: string) {
    const rows = COTIZACION_EMPRESAS.map((c) => ({ id: c.id, title: c.title }));
    await this.sendListMessage(to, '✅ Comunícate con un asesor:', 'Ver asesores', [{ title: 'Cotización de Empresas', rows }]);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
  }
  private async sendDireccionHorarios(to: string) {
    await this.sendMessage(to, DIRECCIONES_HORARIOS);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
  }
  private async sendTrabajoComunidad(to: string) {
    const rows = TRABAJO_COMUNIDAD.map((t) => ({ id: t.id, title: t.title }));
    await this.sendListMessage(to, 'Trabaja con nosotros o únete a nuestra comunidad', 'Ver opciones', [{ title: 'Oportunidades y Comunidad', rows }]);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
  }

  /* =========================
   *  AUDIO → Whisper (OpenAI)
   * ========================= */
  private async downloadWhatsAppMedia(mediaId: string): Promise<{ buffer: Buffer; mime: string }> {
    const meta = await axios.get(`https://graph.facebook.com/v23.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}` },
    });
    const mediaUrl = meta.data?.url;
    if (!mediaUrl) throw new Error('No media url');

    const fileResp = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}` },
    });
    return { buffer: Buffer.from(fileResp.data), mime: fileResp.headers['content-type'] || 'audio/ogg' };
  }

  private async transcribeWhisper(buffer: Buffer, mime: string): Promise<string | null> {
    try {
      const form = new FormData();
      form.append('file', buffer, { filename: 'audio.ogg', contentType: mime });
      form.append('model', 'whisper-1');
      form.append('language', 'es');
      const { data } = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, ...form.getHeaders() },
      });
      return (data?.text || '').trim() || null;
    } catch (e) {
      console.error('Whisper error:', (e as any)?.response?.data || (e as any)?.message || e);
      return null;
    }
  }

  /** expuesto para el controller */
  async handleIncomingAudio(from: string, mediaId: string): Promise<string> {
    try {
      const { buffer, mime } = await this.downloadWhatsAppMedia(mediaId);
      const text = await this.transcribeWhisper(buffer, mime);
      if (!text) return 'No pude entender el audio 😅. ¿Puedes escribirlo o elegir una opción del menú?';
      return await this.generarRespuesta(text, from);
    } catch (e) {
      console.error('handleIncomingAudio:', (e as any)?.message || e);
      return 'Tuvimos un problema con el audio. ¿Puedes escribirlo o elegir una opción del menú?';
    }
  }

  /* =============================
   *  Lógica principal + Registro
   * ============================= */
  async generarRespuesta(text: string, from: string, buttonId?: string): Promise<string> {
    let us = this.userStates.get(from) || { state: 'home' as NavStateName, lastMenu: 'home' as NavStateName };
    us.updatedAt = Date.now();
    this.userStates.set(from, us);

    const t = (text || '').trim();
    const tl = t.toLowerCase();
    const phoneDigits = this.onlyDigits(from).replace(/^591/, ''); // 8 dígitos si venía con 591

    // Consulta cliente (para saludo)
    const client = await this.sheets.findClientByPhone(phoneDigits).catch(() => null);
    const knownName = client?.nombre || '';

    // ===== Registro suave =====
    if (us.state === 'register_name') {
      const nameOk = /^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]{4,}$/.test(t);
      if (!nameOk) return '¿Cómo te gustaría que te llame? (ej. María González)';
      this.setState(from, { state: 'register_email', pendingPhone: (us as any).pendingPhone, tempName: t.trim(), lastMenu: this.getLastMenu(us) });
      return 'Gracias 🙌 ¿Cuál es tu *email*? (opcional, puedes escribir "omitir" para saltar)';
    }
    if (us.state === 'register_email') {
      let email = '';
      if (!/omit/i.test(tl)) {
        const ok = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(t.trim());
        if (!ok) return 'Ese email no parece válido. Prueba con algo como *nombre@ejemplo.com* o escribe "omitir".';
        email = t.trim();
      }
      const { pendingPhone, tempName } = us as any;
      await this.sheets.upsertClientBasic(pendingPhone, tempName, email).catch(() => {});
      await this.sendMessage(from, `¡Listo, ${tempName}! Te tengo anotad@ ✅`);
      this.setState(from, { state: 'home', lastMenu: 'home' });
      await this.sendAceMainMenu(from, tempName);
      return '';
    }

    // ===== Saludo / inicio =====
    if (!buttonId && /(menu|inicio|hola|buenas|hello|hi)/i.test(tl)) {
      if (knownName) {
        await this.sendMessage(from, `¡Hola ${knownName}! Bienvenid@ a ${ACE_NAME} 💪`);
        await this.sendAceMainMenu(from, knownName);
      } else {
        await this.sendMessage(from, ACE_GREETING);
        await this.sendAceMainMenu(from);
        this.setState(from, { state: 'register_name', pendingPhone: phoneDigits, lastMenu: this.getLastMenu(us) });
        await this.sendMessage(from, 'Por cierto, ¿cómo te gustaría que te llame? (ej. María González)');
      }
      return '';
    }

    // Soporte numérico 1..5
    if (!buttonId && /^\d\b/.test(tl)) {
      const num = tl.match(/^\d+/)?.[0];
      if (num) {
        const map: Record<string, string> = { '1': 'm_atencion', '2': 'm_minicuotas', '3': 'm_empresas', '4': 'm_direccion', '5': 'm_trabajo' };
        buttonId = map[num];
      }
    }

    if (buttonId) return this.handleButton(from, buttonId, knownName);

    // Texto libre → no invadir: encaminar a menú
    return '¿Te muestro el menú principal? Escribe *hola* o envía un número (1-5).';
  }

  private async handleButton(from: string, id: string, knownName?: string): Promise<string> {
    if (id === 'home') {
      await this.sendAceMainMenu(from, knownName);
      this.setState(from, { state: 'home', lastMenu: 'home' });
      return '';
    }
    if (id === 'back') {
      const prev = this.getLastMenu(this.userStates.get(from));
      return this.navigateToMenu(from, prev, knownName);
    }

    switch (id) {
      case 'm_atencion':
        await this.sendSubmenuAtencion(from);
        this.setState(from, { state: 'atencion', lastMenu: 'home' });
        return '';
      case 'm_minicuotas':
        await this.sendSubmenuMiniCuotas(from);
        this.setState(from, { state: 'minicuotas', lastMenu: 'home' });
        return '';
      case 'm_empresas':
        await this.sendEmpresas(from);
        this.setState(from, { state: 'empresas', lastMenu: 'home' });
        return '';
      case 'm_direccion':
        await this.sendDireccionHorarios(from);
        this.setState(from, { state: 'direccion', lastMenu: 'home' });
        return '';
      case 'm_trabajo':
        await this.sendTrabajoComunidad(from);
        this.setState(from, { state: 'trabajo', lastMenu: 'home' });
        return '';
    }

    if (id.startsWith('atn_')) {
      const suc = ATENCION_SUCURSALES.find((s) => `atn_${s.id}` === id);
      if (!suc) return 'Sucursal no encontrada.';
      await this.sendMessage(from, `${suc.title}\nLink de WhatsApp: ${suc.link}`);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
      this.setState(from, { state: 'atencion', lastMenu: 'home' });
      return '';
    }

    if (id.startsWith('mc_')) {
      const opt = MINI_CUOTAS.find((m) => `mc_${m.id}` === id);
      if (!opt) return 'Opción no encontrada.';
      const label = opt.title.startsWith('Requisitos') ? 'Link de los requisitos' : 'Link del ejecutivo';
      await this.sendMessage(from, `${opt.title}\n${label}: ${opt.link}`);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
      this.setState(from, { state: 'minicuotas', lastMenu: 'home' });
      return '';
    }

    if (id.startsWith('emp_')) {
      const ases = COTIZACION_EMPRESAS.find((e) => e.id === id);
      if (!ases) return 'Asesor no encontrado.';
      await this.sendMessage(from, `✅ Comunícate con un asesor:\n${ases.title}: ${ases.link}`);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
      this.setState(from, { state: 'empresas', lastMenu: 'home' });
      return '';
    }

    if (id.startsWith('wrk_')) {
      const w = TRABAJO_COMUNIDAD.find((x) => x.id === id);
      if (!w) return 'Opción no encontrada.';
      await this.sendMessage(from, `${w.title}\n${w.text}`);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
      this.setState(from, { state: 'trabajo', lastMenu: 'home' });
      return '';
    }

    return 'No reconozco esa opción. Escribe "hola" para ver el menú.';
  }

  private async navigateToMenu(to: string, menu: NavStateName, knownName?: string) {
    switch (menu) {
      case 'home':
      default:
        await this.sendAceMainMenu(to, knownName);
        this.setState(to, { state: 'home', lastMenu: 'home' });
        return '';
      case 'atencion':
        await this.sendSubmenuAtencion(to);
        this.setState(to, { state: 'atencion', lastMenu: 'home' });
        return '';
      case 'minicuotas':
        await this.sendSubmenuMiniCuotas(to);
        this.setState(to, { state: 'minicuotas', lastMenu: 'home' });
        return '';
      case 'empresas':
        await this.sendEmpresas(to);
        this.setState(to, { state: 'empresas', lastMenu: 'home' });
        return '';
      case 'direccion':
        await this.sendDireccionHorarios(to);
        this.setState(to, { state: 'direccion', lastMenu: 'home' });
        return '';
      case 'trabajo':
        await this.sendTrabajoComunidad(to);
        this.setState(to, { state: 'trabajo', lastMenu: 'home' });
        return '';
    }
  }

  /* ===== Compat horario/ubicación previos ===== */
  private async sendHours(to: string) { return this.sendMessage(to, COMPANY_HOURS_TEXT); }
  private async sendLocation(to: string) { return this.sendMessage(to, COMPANY_LOCATION_TEXT); }
}
