// src/whatsapp/whatsapp.service.ts
import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as FormData from 'form-data';
import { SheetsService } from '../sheets/sheets.service';
import { PdfService } from '../pdf/pdf.service';

/** =========================
 *  Config Ace Hardware (chat)
 *  ========================= */
const ACE_NAME = 'Ace Hardware';
const ACE_GREETING = '¡Hola! Bienvenido a Ace Hardware 💪\n¿En qué te podemos ayudar el día de hoy?';

const BTN_HOME = { type: 'reply', reply: { id: 'home', title: '🏠 Menú Principal' } };

/** Links y textos del flujo */
const ATENCION_SUCURSALES = [
  { id: 'suc_banzer',       title: '✅ Suc. Av. Banzer 5to y 6to anillo',            link: 'https://wa.link/7i0euc' },
  { id: 'suc_doble_via',    title: '✅ Suc. Av. Doble vía la guardia 5to',            link: 'https://wa.link/g4a1a7' },
  { id: 'suc_virgen_cotoca',title: '✅ Suc. Av. Virgen de Cotoca 4to y 5to',          link: 'https://wa.link/08g18a' },
];

const MINI_CUOTAS = [
  { id: 'mc_banzer',     title: 'Ej. Suc. Banzer 5to y 6to anillo',                   link: 'https://wa.link/ez2y4f' },
  { id: 'mc_doble_via',  title: 'Ej. Suc. Doble vía 5to anillo',                      link: 'https://wa.link/w8e6f3' },
  { id: 'mc_requisitos', title: 'Requisitos Mini Cuotas',                             link: 'https://www.dismac.com.bo/minicuotas.html' },
];

const COTIZACION_EMPRESAS = [
  { id: 'emp_asesor1', title: 'Asesor1', link: 'https://wa.link/w06z6f' },
  { id: 'emp_asesor2', title: 'Asesor2', link: 'https://wa.link/c7c0nb' },
];

const DIRECCIONES_HORARIOS = {
  text:
    'Visítanos en nuestras 3 sucursales:\n' +
    '📍 Av. Banzer, entre 5to y 6to anillo.\n' +
    '   Ubicación: http://bit.ly/3RKFcy2\n\n' +
    '📍 Av. Doble Vía La Guardia, entre 5to y 6to anillo.\n' +
    '   Ubicación: https://bit.ly/UbicacionDobleVia\n\n' +
    '📍 Av. Virgen de Cotoca, entre 4to y 5to anillo.\n' +
    '   Ubicación: https://bit.ly/UbicacionVirgenDeCotoca\n\n' +
    '🕥 Lunes a Viernes: 7:30 - 21:00 hrs\n' +
    '🕥 Sábado y Domingo: 8:30 - 20:30 hrs',
};

/** “Trabaja/Comunidad” — títulos cortos y claros (para que no confundan si se cortan). */
const TRABAJO_COMUNIDAD = [
  {
    id: 'wrk_proveedor',
    title: '✅ Proveedor / Trabajar',
    text: 'Si quieres ser proveedor o trabajar con nosotros, envíanos un correo ✉ contacto@acebolivia.com.bo',
  },
  {
    id: 'wrk_canal',
    title: '✅ Únete a nuestro canal',
    text:
      'Únete a nuestro canal de WhatsApp 🥰\n' +
      'Entérate de las novedades, talleres y ofertas exclusivas antes que nadie aquí:\n' +
      'https://whatsapp.com/channel/0029VbAVvdP77qVLD6SpkJ3I',
  },
];

/** ==========================================
 *  Compat con tus helpers antiguos (horario/ubicación)
 *  ========================================== */
const COMPANY_HOURS_TEXT = 'Nuestro horario de atención es de *Lunes a Viernes* de *08:00–12:00 y 14:30–18:30*';
const COMPANY_MAPS_URL   = 'https://maps.app.goo.gl/TU82fjJzHG3RBAbTA';
const COMPANY_LOCATION_TEXT =
  'Nuestra ubicación es: \n 📍 Russell Bedford Bolivia – Encinas Auditores y Consultores SRL\n' + COMPANY_MAPS_URL;

/** ====== Tipos ====== */
type CRMProfile = { phone: string; name?: string; email?: string; known?: boolean };
type KnownState =
  | { state: 'home' | 'atencion' | 'minicuotas' | 'empresas' | 'direccion' | 'trabajo'; updatedAt?: number; knownName?: string }
  | { state: 'register_name'; pendingPhone: string; updatedAt?: number }
  | { state: 'register_email'; pendingPhone: string; tempName: string; updatedAt?: number };

@Injectable()
export class WhatsappService {
  private readonly API_URL = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`;
  private readonly HEADERS = {
    Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`,
    'Content-Type': 'application/json',
  };

  // Memoria rápida para estados y “mini CRM”. (Si quieres, luego lo persistimos a Sheets)
  private userStates = new Map<string, KnownState>();
  private crm = new Map<string, CRMProfile>(); // key = phone (E.164 sin signos)

  constructor(private readonly sheets: SheetsService, private readonly pdf: PdfService) {
    setInterval(() => this.cleanOldStates(), 24 * 60 * 60 * 1000);
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
        action: { button: buttonText.length <= 20 ? buttonText : buttonText.slice(0, 19) + '…', sections },
      },
    };
    try {
      const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return data;
    } catch {
      // Fallback a botones (máx. 3)
      const simpleButtons = sections
        .flatMap((s) =>
          (s.rows || []).map((r: any) => ({
            type: 'reply',
            reply: { id: r.id, title: (r.title || 'Opción').slice(0, 20) },
          })),
        )
        .slice(0, 3);
      if (!simpleButtons.length) simpleButtons.push({ type: 'reply', reply: { id: 'home', title: 'Menú Principal' } });
      return this.sendButtons(to, message, simpleButtons);
    }
  }

  async uploadMediaToWhatsApp(buffer: Buffer, filename: string, mime = 'application/pdf'): Promise<string> {
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('file', buffer, { filename, contentType: mime });
    const url = `https://graph.facebook.com/v23.0/${process.env.WHATSAPP_PHONE_NUMBER_ID}/media`;
    const { data } = await axios.post(url, form, {
      headers: { Authorization: `Bearer ${process.env.WHATSAPP_CLOUD_API_TOKEN}`, ...form.getHeaders() },
    });
    return data.id as string;
  }
  async sendDocumentByMediaId(to: string, mediaId: string, filename: string, caption: string) {
    const body = { messaging_product: 'whatsapp', to, type: 'document', document: { id: mediaId, caption, filename } };
    const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
    return data;
  }

  /* ========== Helpers ========== */
  private cleanOldStates() {
    const now = Date.now();
    const cutoff = now - 24 * 60 * 60 * 1000;
    for (const [k, v] of this.userStates.entries()) if ((v as any)?.updatedAt < cutoff) this.userStates.delete(k);
  }
  private onlyDigits(s = '') { return String(s || '').replace(/[^\d]/g, ''); }
  private normalize(t = '') { return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim(); }

  /* =============================
   *  Registro básico antes del menú
   * ============================= */
  private getPhoneKey(waFrom: string) {
    // de "5917xxxxx" a "5917xxxxx" (ya viene sin +)
    return this.onlyDigits(waFrom);
  }

  private ensureCRMProfile(waFrom: string): CRMProfile {
    const key = this.getPhoneKey(waFrom);
    const cur = this.crm.get(key);
    if (cur) return cur;
    const profile: CRMProfile = { phone: key, known: false };
    this.crm.set(key, profile);
    return profile;
  }

  private async startRegistration(from: string) {
    const profile = this.ensureCRMProfile(from);
    // si ya lo tengo con nombre, salto a email; si también tiene email, ya muestro menú
    if (!profile.name) {
      this.userStates.set(from, { state: 'register_name', pendingPhone: profile.phone, updatedAt: Date.now() });
      await this.sendMessage(from, 'Por cierto, ¿cómo te gustaría que te llame? (ej. María González)');
      return;
    }
    if (!profile.email) {
      this.userStates.set(from, { state: 'register_email', pendingPhone: profile.phone, tempName: profile.name, updatedAt: Date.now() });
      await this.sendMessage(from, 'Gracias 🙌 ¿Cuál es tu *email*? (opcional, puedes escribir "omitir" para saltar)');
      return;
    }
    // ya tiene todo → directo a menú
    await this.sendAceMainMenu(from, profile.name);
    this.userStates.set(from, { state: 'home', updatedAt: Date.now(), knownName: profile.name });
  }

  private async processRegistrationInput(from: string, text: string): Promise<string> {
    const st = this.userStates.get(from);
    if (!st) return '';

    if (st.state === 'register_name') {
      const name = String(text || '').trim();
      if (!/^[A-Za-zÁÉÍÓÚÜÑáéíóúüñ ]{4,}$/.test(name)) {
        return 'Usa sólo letras y espacios (ej. María González).';
      }
      const key = (st as any).pendingPhone;
      const p = this.ensureCRMProfile(from);
      p.name = name;
      p.known = true;
      this.crm.set(key, p);

      this.userStates.set(from, { state: 'register_email', pendingPhone: key, tempName: name, updatedAt: Date.now() });
      await this.sendMessage(from, 'Gracias 🙌 ¿Cuál es tu *email*? (opcional, puedes escribir "omitir" para saltar)');
      return '';
    }

    if (st.state === 'register_email') {
      const val = String(text || '').trim();
      const key = (st as any).pendingPhone;
      const p = this.ensureCRMProfile(from);
      if (val.toLowerCase() !== 'omitir') {
        const ok = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(val);
        if (!ok) return 'Ese email no parece válido. Prueba con algo como nombre@ejemplo.com o escribe "omitir".';
        p.email = val.toLowerCase();
      }
      p.known = true;
      this.crm.set(key, p);

      await this.sendAceMainMenu(from, p.name);
      this.userStates.set(from, { state: 'home', updatedAt: Date.now(), knownName: p.name });
      return '';
    }

    return '';
  }

  /* =============================
   *  Menú principal (ahora personalizable)
   * ============================= */
  private async sendAceMainMenu(to: string, knownName?: string) {
    const header = knownName
      ? `👋 ${knownName}, estas son las opciones:`
      : 'Selecciona tu consulta escribiendo el número o tocando:';

    const sections = [
      {
        title: 'Menú principal',
        rows: [
          { id: 'm_atencion',   title: '1. Atención' },
          { id: 'm_minicuotas', title: '2. Mini Cuotas' },
          { id: 'm_empresas',   title: '3. Empresas' },
          { id: 'm_direccion',  title: '4. Dirección/horario' },
          { id: 'm_trabajo',    title: '5. Trabajar/Comunidad' },
        ],
      },
    ];
    await this.sendListMessage(to, header, 'Abrir menú', sections);
  }

  /* =============================
   *  Submenús (sólo “Menú Principal” como acción rápida)
   * ============================= */
  private async sendSubmenuAtencion(to: string) {
    const rows = ATENCION_SUCURSALES.map((s) => ({ id: `atn_${s.id}`, title: s.title }));
    await this.sendListMessage(to, 'Selecciona tu sucursal:', 'Ver sucursales', [{ title: 'Atención al cliente', rows }]);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_HOME]);
  }
  private async sendSubmenuMiniCuotas(to: string) {
    const rows = MINI_CUOTAS.map((m) => ({ id: `mc_${m.id}`, title: m.title }));
    await this.sendListMessage(to, 'Selecciona tu ejecutivo o ver requisitos:', 'Ver opciones', [{ title: 'Mini Cuotas', rows }]);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_HOME]);
  }
  private async sendEmpresas(to: string) {
    const rows = COTIZACION_EMPRESAS.map((c) => ({ id: c.id, title: c.title }));
    await this.sendListMessage(to, '✅ Comunícate con un asesor:', 'Ver asesores', [{ title: 'Cotización de Empresas', rows }]);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_HOME]);
  }
  private async sendDireccionHorarios(to: string) {
    await this.sendMessage(to, DIRECCIONES_HORARIOS.text);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_HOME]);
  }
  private async sendTrabajoComunidad(to: string) {
    // Cuerpo respetando tu texto original
    const rows = TRABAJO_COMUNIDAD.map((t) => ({ id: t.id, title: t.title }));
    await this.sendListMessage(to, 'Trabaja con nosotros o únete a nuestra comunidad', 'Ver opciones', [
      { title: 'Oportunidades y Comunidad', rows },
    ]);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_HOME]);
  }

  /* =============================
   *  Lógica principal
   * ============================= */
  async generarRespuesta(text: string, from: string, buttonId?: string): Promise<string> {
    const current = this.userStates.get(from);
    const now = Date.now();

    // 1) Si estoy registrando, proceso primero
    if (current?.state === 'register_name' || current?.state === 'register_email') {
      const r = await this.processRegistrationInput(from, text || '');
      if (r) return r;
      return '';
    }

    // 2) Primer contacto / saludo → NO mostrar menú hasta pedir datos
    const t = (text || '').trim().toLowerCase();
    if (!buttonId && /(menu|inicio|hola|buenas|hello|hi)/i.test(t)) {
      await this.sendMessage(from, ACE_GREETING);
      await this.startRegistration(from);
      return '';
    }

    // 3) Soporte numérico 1-5 desde texto (sólo cuando ya está en estado normal)
    if (!buttonId && /^\d\b/.test(t) && (!current || ('home' in current))) {
      const num = t.match(/^\d+/)?.[0];
      if (num) {
        const map: Record<string, string> = {
          '1': 'm_atencion',
          '2': 'm_minicuotas',
          '3': 'm_empresas',
          '4': 'm_direccion',
          '5': 'm_trabajo',
        };
        buttonId = map[num];
      }
    }

    // 4) Navegación por botón/lista
    if (buttonId) return this.handleButton(from, buttonId, (current as any)?.knownName);

    // 5) Fallback
    return 'Escribe *hola* para comenzar.';
  }

  private async handleButton(from: string, id: string, knownName?: string): Promise<string> {
    // home
    if (id === 'home') {
      await this.sendAceMainMenu(from, knownName);
      this.userStates.set(from, { state: 'home', updatedAt: Date.now(), knownName });
      return '';
    }

    // Menú principal
    switch (id) {
      case 'm_atencion':
        await this.sendSubmenuAtencion(from);
        this.userStates.set(from, { state: 'atencion', updatedAt: Date.now(), knownName });
        return '';
      case 'm_minicuotas':
        await this.sendSubmenuMiniCuotas(from);
        this.userStates.set(from, { state: 'minicuotas', updatedAt: Date.now(), knownName });
        return '';
      case 'm_empresas':
        await this.sendEmpresas(from);
        this.userStates.set(from, { state: 'empresas', updatedAt: Date.now(), knownName });
        return '';
      case 'm_direccion':
        await this.sendDireccionHorarios(from);
        this.userStates.set(from, { state: 'direccion', updatedAt: Date.now(), knownName });
        return '';
      case 'm_trabajo':
        await this.sendTrabajoComunidad(from);
        this.userStates.set(from, { state: 'trabajo', updatedAt: Date.now(), knownName });
        return '';
    }

    // Submenú: Atención
    if (id.startsWith('atn_')) {
      const suc = ATENCION_SUCURSALES.find((s) => `atn_${s.id}` === id);
      if (!suc) return 'Sucursal no encontrada.';
      await this.sendMessage(from, `${suc.title}\nLink de WhatsApp: ${suc.link}`);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_HOME]);
      this.userStates.set(from, { state: 'atencion', updatedAt: Date.now(), knownName });
      return '';
    }

    // Submenú: Mini Cuotas
    if (id.startsWith('mc_')) {
      const opt = MINI_CUOTAS.find((m) => `mc_${m.id}` === id);
      if (!opt) return 'Opción no encontrada.';
      const label = opt.title.startsWith('Requisitos') ? 'Link de los requisitos' : 'Link del ejecutivo';
      await this.sendMessage(from, `${opt.title}\n${label}: ${opt.link}`);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_HOME]);
      this.userStates.set(from, { state: 'minicuotas', updatedAt: Date.now(), knownName });
      return '';
    }

    // Submenú: Empresas
    if (id.startsWith('emp_')) {
      const ases = COTIZACION_EMPRESAS.find((e) => e.id === id);
      if (!ases) return 'Asesor no encontrado.';
      await this.sendMessage(from, `✅ Comunícate con un asesor:\n${ases.title}: ${ases.link}`);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_HOME]);
      this.userStates.set(from, { state: 'empresas', updatedAt: Date.now(), knownName });
      return '';
    }

    // Submenú: Trabajo / Comunidad
    if (id.startsWith('wrk_')) {
      const w = TRABAJO_COMUNIDAD.find((x) => x.id === id);
      if (!w) return 'Opción no encontrada.';
      // Envía el texto completo para que el cliente entienda aunque el título se corte en la UI
      await this.sendMessage(from, w.text);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_HOME]);
      this.userStates.set(from, { state: 'trabajo', updatedAt: Date.now(), knownName });
      return '';
    }

    return 'No reconozco esa opción. Escribe "hola" para ver el menú.';
  }

  /** =============================
   *  (Compat) Horario / Ubicación previos
   *  ============================= */
  private async sendHours(to: string) { return this.sendMessage(to, COMPANY_HOURS_TEXT); }
  private async sendLocation(to: string) { return this.sendMessage(to, COMPANY_LOCATION_TEXT); }
}
