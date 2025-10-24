import { Injectable } from '@nestjs/common';
import axios from 'axios';
import * as FormData from 'form-data';
import { SheetsService, SlotOffered } from '../sheets/sheets.service';
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
  {
    id: 'suc_banzer',
    title: '✅ Suc. Av. Banzer 5to y 6to anillo',
    link: 'https://wa.link/7i0euc',
  },
  {
    id: 'suc_doble_via',
    title: '✅ Suc. Av. Doble vía la guardia 5to',
    link: 'https://wa.link/g4a1a7',
  },
  {
    id: 'suc_virgen_cotoca',
    title: '✅ Suc. Av. Virgen de Cotoca 4to y 5to',
    link: 'https://wa.link/08g18a',
  },
];

const MINI_CUOTAS = [
  {
    id: 'mc_banzer',
    title: 'Ej. Suc. Banzer 5to y 6to anillo',
    link: 'https://wa.link/ez2y4f',
  },
  {
    id: 'mc_doble_via',
    title: 'Ej. Suc. Doble vía 5to anillo',
    link: 'https://wa.link/w8e6f3',
  },
  {
    id: 'mc_requisitos',
    title: 'Requisitos Mini Cuotas',
    link: 'https://www.dismac.com.bo/minicuotas.html',
  },
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

const TRABAJO_COMUNIDAD = [
  {
    id: 'wrk_proveedor',
    title: '✅ Ser proveedor o trabajar con nosotros',
    text: 'Envíanos un correo ✉ contacto@acebolivia.com.bo',
  },
  {
    id: 'wrk_canal',
    title: '✅ Únete a nuestro canal de WhatsApp 🥰',
    text:
      'Entérate de novedades, talleres y ofertas exclusivas aquí:\n' +
      'https://whatsapp.com/channel/0029VbAVvdP77qVLD6SpkJ3I',
  },
];

/** ==========================================
 *  ATENCIÓN: Mantengo tus dependencias y helpers
 *  ========================================== */
const COMPANY_NAME =
  'Russell Bedford Bolivia Encinas Auditores y Consultores SRL'; // ⚠️ Se usa en PDF existente
const COMPANY_PHONE_E164 = '+59170400175'; // para vCard temporal (compat)
const COMPANY_HOURS_TEXT =
  'Nuestro horario de atención es de *Lunes a Viernes* de *08:00–12:00 y 14:30–18:30*';
const COMPANY_MAPS_URL = 'https://maps.app.goo.gl/TU82fjJzHG3RBAbTA';
const COMPANY_LOCATION_TEXT =
  'Nuestra ubicación es: \n 📍 Russell Bedford Bolivia – Encinas Auditores y Consultores SRL\n' +
  COMPANY_MAPS_URL;

type ClientData = {
  nombre?: string;
  telefono?: string;
  email?: string;
  servicio?: string;
  fecha?: string;
  hora?: string;
};

type UserState = {
  state: 'home' | 'atencion' | 'minicuotas' | 'empresas' | 'direccion' | 'trabajo';
  lastMenu?: 'home' | 'atencion' | 'minicuotas' | 'empresas' | 'direccion' | 'trabajo';
  updatedAt?: number;
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

  // Mantengo estos catálogos por compatibilidad aunque el flujo de Ace no agenda.
  private readonly SERVICE_CATALOG = [
    { id: 'tributario', label: 'Asesoría Tributaria', aliases: ['impuestos', 'fiscal', 'sat', 'tributaria'] },
    { id: 'legal', label: 'Asesoría Legal', aliases: ['contrato', 'abogado', 'ley', 'juridico', 'jurídico'] },
    { id: 'laboral', label: 'Asesoría Laboral', aliases: ['empleo', 'trabajo', 'contratación', 'despido'] },
    { id: 'conta', label: 'Contabilidad', aliases: ['contable', 'libros', 'declaraciones', 'facturación', 'facturacion'] },
    { id: 'sistemas', label: 'Sistemas Informáticos', aliases: ['software', 'redes', 'informática', 'informatica', 'tecnología', 'tecnologia'] },
  ];

  private userStates = new Map<string, UserState>();

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
        action: { button: buttonText, sections },
      },
    };

    // Helper: título de botón <= 20 chars (para fallback seguro)
    const toBtnTitle = (s: string) => {
      const str = String(s || '').trim();
      if (str.length <= 20) return str || 'Opción';
      return str.slice(0, 19) + '…'; // 19 + '…' = 20
    };

    try {
      const { data } = await axios.post(this.API_URL, body, { headers: this.HEADERS });
      return data;
    } catch {
      // Fallback a botones (máx. 3) con títulos truncados (<=20)
      const simpleButtons = sections
        .flatMap((s) =>
          (s.rows || []).map((r: any) => ({
            type: 'reply',
            reply: { id: r.id, title: toBtnTitle(r.title) },
          }))
        )
        .slice(0, 3);

      if (!simpleButtons.length) {
        simpleButtons.push({ type: 'reply', reply: { id: 'home', title: 'Menú' } });
      }

      return this.sendButtons(to, message, simpleButtons);
    }
  }

  // Enviar contacto (vCard)
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
      return this.sendMessage(to, `📇 ${fullName}\n📞 ${phoneE164}`);
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

  private normalize(t = '') {
    return t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
  }

  /** =============================
   *  Menú principal (Lista)
   *  ============================= */
  private async sendAceMainMenu(to: string) {
    const sections = [
      {
        title: 'Menú principal',
        rows: [
          { id: 'm_atencion', title: '1. Atención' },
          { id: 'm_minicuotas', title: '2. Mini Cuotas' },
          { id: 'm_empresas', title: '3. Empresas' },
          { id: 'm_direccion', title: '4. Dirección/horario' },
          { id: 'm_trabajo', title: '5. Trabajar/Comunidad' },
        ],
      },
    ];
    await this.sendListMessage(to, 'Selecciona tu consulta escribiendo el número o tocando:', 'Abrir menú', sections);
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
    // Usamos los IDs tal como están en el array (emp_asesor1, emp_asesor2)
    const rows = COTIZACION_EMPRESAS.map((c) => ({ id: c.id, title: c.title }));
    await this.sendListMessage(to, '✅ Comunícate con un asesor:', 'Ver asesores', [{ title: 'Cotización de Empresas', rows }]);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
  }

  private async sendDireccionHorarios(to: string) {
    await this.sendMessage(to, DIRECCIONES_HORARIOS.text);
    await this.sendButtons(to, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
  }

  private async sendTrabajoComunidad(to: string) {
    // Usamos los IDs tal como están (wrk_proveedor, wrk_canal)
    const rows = TRABAJO_COMUNIDAD.map((t) => ({ id: t.id, title: t.title }));
    await this.sendListMessage(
      to,
      'Trabaja con nosotros o únete a nuestra comunidad',
      'Ver opciones',
      [{ title: 'Oportunidades y Comunidad', rows }]
    );
    await this.sendButtons(to, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
  }

  /** =============================
   *  Lógica principal
   *  ============================= */
  async generarRespuesta(text: string, from: string, buttonId?: string): Promise<string> {
    const st = this.userStates.get(from) || { state: 'home' as const, lastMenu: 'home' as const };
    st.updatedAt = Date.now();
    this.userStates.set(from, st);

    // Reacciones globales
    const t = (text || '').trim().toLowerCase();

    // Frases de inicio
    if (!buttonId && /(menu|inicio|hola|buenas|hello|hi)/i.test(t)) {
      await this.sendMessage(from, ACE_GREETING);
      await this.sendAceMainMenu(from);
      this.userStates.set(from, { state: 'home', lastMenu: 'home', updatedAt: Date.now() });
      return '';
    }

    // Soporte numérico 1-5 desde texto
    if (!buttonId && /^\d\b/.test(t)) {
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

    if (buttonId) return this.handleButton(from, buttonId);

    return 'Escribe *hola* para ver el menú principal o envía un número (1-5).';
  }

  private async handleButton(from: string, id: string): Promise<string> {
    // Navegación base
    if (id === 'home') {
      await this.sendAceMainMenu(from);
      this.userStates.set(from, { state: 'home', lastMenu: 'home', updatedAt: Date.now() });
      return '';
    }
    if (id === 'back') {
      const prev = this.userStates.get(from)?.lastMenu || 'home';
      return this.navigateToMenu(from, prev);
    }

    // Menú principal
    switch (id) {
      case 'm_atencion':
        await this.sendSubmenuAtencion(from);
        this.userStates.set(from, { state: 'atencion', lastMenu: 'home', updatedAt: Date.now() });
        return '';
      case 'm_minicuotas':
        await this.sendSubmenuMiniCuotas(from);
        this.userStates.set(from, { state: 'minicuotas', lastMenu: 'home', updatedAt: Date.now() });
        return '';
      case 'm_empresas':
        await this.sendEmpresas(from);
        this.userStates.set(from, { state: 'empresas', lastMenu: 'home', updatedAt: Date.now() });
        return '';
      case 'm_direccion':
        await this.sendDireccionHorarios(from);
        this.userStates.set(from, { state: 'direccion', lastMenu: 'home', updatedAt: Date.now() });
        return '';
      case 'm_trabajo':
        await this.sendTrabajoComunidad(from);
        this.userStates.set(from, { state: 'trabajo', lastMenu: 'home', updatedAt: Date.now() });
        return '';
    }

    // Submenú: Atención (sucursales)
    if (id.startsWith('atn_')) {
      const suc = ATENCION_SUCURSALES.find((s) => `atn_${s.id}` === id);
      if (!suc) return 'Sucursal no encontrada.';
      await this.sendMessage(from, `${suc.title}\nLink de WhatsApp: ${suc.link}`);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
      this.userStates.set(from, { state: 'atencion', lastMenu: 'home', updatedAt: Date.now() });
      return '';
    }

    // Submenú: Mini Cuotas
    if (id.startsWith('mc_')) {
      const opt = MINI_CUOTAS.find((m) => `mc_${m.id}` === id);
      if (!opt) return 'Opción no encontrada.';
      const label = opt.title.startsWith('Requisitos') ? 'Link de los requisitos' : 'Link del ejecutivo';
      await this.sendMessage(from, `${opt.title}\n${label}: ${opt.link}`);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
      this.userStates.set(from, { state: 'minicuotas', lastMenu: 'home', updatedAt: Date.now() });
      return '';
    }

    // Submenú: Empresas (IDs directos emp_asesorX)
    if (id.startsWith('emp_')) {
      const ases = COTIZACION_EMPRESAS.find((e) => e.id === id);
      if (!ases) return 'Asesor no encontrado.';
      await this.sendMessage(from, `✅ Comunícate con un asesor:\n${ases.title}: ${ases.link}`);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
      this.userStates.set(from, { state: 'empresas', lastMenu: 'home', updatedAt: Date.now() });
      return '';
    }

    // Submenú: Trabajo / Comunidad (IDs directos wrk_proveedor / wrk_canal)
    if (id.startsWith('wrk_')) {
      const w = TRABAJO_COMUNIDAD.find((x) => x.id === id);
      if (!w) return 'Opción no encontrada.';
      await this.sendMessage(from, `${w.title}\n${w.text}`);
      await this.sendButtons(from, 'Opciones rápidas', [BTN_BACK, BTN_HOME]);
      this.userStates.set(from, { state: 'trabajo', lastMenu: 'home', updatedAt: Date.now() });
      return '';
    }

    return 'No reconozco esa opción. Escribe "hola" para ver el menú.';
  }

  private async navigateToMenu(to: string, menu: UserState['lastMenu']) {
    switch (menu) {
      case 'home':
      default:
        await this.sendAceMainMenu(to);
        this.userStates.set(to, { state: 'home', lastMenu: 'home', updatedAt: Date.now() });
        return '';
      case 'atencion':
        await this.sendSubmenuAtencion(to);
        this.userStates.set(to, { state: 'atencion', lastMenu: 'home', updatedAt: Date.now() });
        return '';
      case 'minicuotas':
        await this.sendSubmenuMiniCuotas(to);
        this.userStates.set(to, { state: 'minicuotas', lastMenu: 'home', updatedAt: Date.now() });
        return '';
      case 'empresas':
        await this.sendEmpresas(to);
        this.userStates.set(to, { state: 'empresas', lastMenu: 'home', updatedAt: Date.now() });
        return '';
      case 'direccion':
        await this.sendDireccionHorarios(to);
        this.userStates.set(to, { state: 'direccion', lastMenu: 'home', updatedAt: Date.now() });
        return '';
      case 'trabajo':
        await this.sendTrabajoComunidad(to);
        this.userStates.set(to, { state: 'trabajo', lastMenu: 'home', updatedAt: Date.now() });
        return '';
    }
  }

  /** =============================
   *  (Compat) Horario / Ubicación previos
   *  ============================= */
  private async sendHours(to: string) {
    return this.sendMessage(to, COMPANY_HOURS_TEXT);
  }
  private async sendLocation(to: string) {
    return this.sendMessage(to, COMPANY_LOCATION_TEXT);
  }
}
