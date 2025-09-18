import { Injectable } from '@nestjs/common';
import { google } from 'googleapis';

export type SlotOffered = { row: number; date: string; time: string; label: string; fallback?: boolean };

@Injectable()
export class SheetsService {
  private sheets: any;
  private SPREADSHEET_ID!: string;

  private readonly TAB_SLOTS = process.env.SHEETS_TAB_SLOTS || 'Horarios';
  private readonly TAB_APPTS = process.env.SHEETS_TAB_APPOINTMENTS || 'Citas';
  private readonly LOCAL_TZ = process.env.LOCAL_TZ || 'America/La_Paz';
  private readonly RETRY_ATTEMPTS = 3;
  private readonly RETRY_DELAY_MS = 600;

  constructor() {
    this.setupGoogleSheetsAuth()
      .then(() => this.seedMonthSlotsIfEmpty().catch(() => {}))
      .catch((e) => console.error('Error configurando Google Sheets:', e?.message || e));
  }

  /* ================= Auth ================= */
  private async setupGoogleSheetsAuth() {
    this.SPREADSHEET_ID = (process.env.SHEETS_SPREADSHEET_ID || process.env.GOOGLE_SHEETS_ID || process.env.GOOGLE_SHEET_ID || '').trim();
    if (!this.SPREADSHEET_ID) throw new Error('Falta SHEETS_SPREADSHEET_ID/GOOGLE_SHEETS_ID (usa SOLO el ID de la planilla).');

    const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

    const raw = process.env.GOOGLE_CREDENTIALS_JSON?.trim();
    if (raw) {
      let creds: any;
      try { creds = JSON.parse(raw); }
      catch {
        const decoded = Buffer.from(raw, 'base64').toString('utf8');
        creds = JSON.parse(decoded);
      }
      const auth = new google.auth.GoogleAuth({ credentials: creds, scopes });
      this.sheets = google.sheets({ version: 'v4', auth });
      return;
    }

    const keyFile = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
    if (!keyFile) throw new Error('Define GOOGLE_CREDENTIALS_JSON o GOOGLE_APPLICATION_CREDENTIALS (ruta al .json).');
    if (keyFile.length > 300) throw new Error('GOOGLE_APPLICATION_CREDENTIALS debe ser una ruta a archivo, no JSON inline.');

    const auth = new google.auth.GoogleAuth({ keyFile, scopes });
    this.sheets = google.sheets({ version: 'v4', auth });
  }

  /* =============== Público (lectura/escritura) =============== */

  /** Horas disponibles de una fecha específica (sólo filas con estado DISPONIBLE) */
  async getSlotsForDate(dateYMD: string): Promise<SlotOffered[]> {
    const r: any = await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.get({ spreadsheetId: this.SPREADSHEET_ID, range: `${this.TAB_SLOTS}!A2:G` })
    );

    const rows: string[][] = r.data.values || [];
    const out: SlotOffered[] = [];

    for (let i = 0; i < rows.length; i++) {
      const rowIdx = i + 2; // header en la fila 1
      const fecha = (rows[i][0] || '').trim();      // A fecha
      const hora = (rows[i][1] || '').trim();       // B hora
      const estado = ((rows[i][3] || '') + '').trim().toUpperCase(); // D estado (C es servicio)
      if (fecha === dateYMD && (!estado || estado === 'DISPONIBLE')) {
        out.push({ row: rowIdx, date: fecha, time: hora, label: `${fecha} • ${hora}` });
      }
    }
    // ordena por hora asc
    out.sort((a, b) => a.time.localeCompare(b.time));
    return out;
  }

  /** Reservar fila: escribe servicio, estado RESERVADO, reservado_por, Fecha(timestamp ISO) */
  async reserveSlotRow(rowNumber: number, byPhone: string, serviceType: string): Promise<boolean> {
    if (rowNumber <= 0) return false;
    const readRange = `${this.TAB_SLOTS}!A${rowNumber}:G${rowNumber}`;
    const read: any = await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.get({ spreadsheetId: this.SPREADSHEET_ID, range: readRange })
    );
    const cur = (read.data.values && read.data.values[0]) || [];
    const estadoActual = ((cur[3] || '') + '').toUpperCase(); // D

    if (estadoActual && estadoActual !== 'DISPONIBLE') return false;

    // Actualiza C..G → servicio, estado, notas, reservado_por, Fecha
    const writeRange = `${this.TAB_SLOTS}!C${rowNumber}:G${rowNumber}`;
    await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.update({
        spreadsheetId: this.SPREADSHEET_ID,
        range: writeRange,
        valueInputOption: 'RAW',
        requestBody: { values: [[serviceType || '', 'RESERVADO', '', this.onlyDigits(byPhone), new Date().toISOString()]] },
      })
    );
    return true;
  }

  /** Inserta cita en la pestaña Citas */
  async appendAppointmentRow(opts: {
    telefono: string; nombre: string; email: string; servicio: string;
    fecha: string; hora: string; slotRow: number | string;
  }) {
    const row = [
      new Date().toISOString(),                // creado_iso
      this.onlyDigits(opts.telefono || ''),    // telefono
      String(opts.nombre || ''),               // nombre
      String(opts.email || ''),                // email
      String(opts.servicio || ''),             // servicio
      String(opts.fecha || ''),                // fecha_cita
      String(opts.hora || ''),                 // hora_cita
      'CONFIRMADA',                            // estado
      String(opts.slotRow || ''),              // slot_row
      '',                                      // calendar_event_id (opcional)
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

  /** Próximos N días hábiles (sin domingos ni feriados de Santa Cruz/BO) */
  async getNextWorkingDays(n: number): Promise<string[]> {
    const out: string[] = [];
    const { y, m, day } = this.todayYMD();
    let cursor = new Date(Date.UTC(y, m - 1, day));

    while (out.length < n) {
      const ymd = this.ymdLocal(cursor);
      if (!this.isHolidayOrSunday(cursor)) out.push(ymd);
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }
    return out;
  }

  /* =============== Si está vacío, siembra 1 mes ================= */
  private async seedMonthSlotsIfEmpty() {
    const r: any = await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.get({ spreadsheetId: this.SPREADSHEET_ID, range: `${this.TAB_SLOTS}!A2:A` })
    );
    const existing = (r.data.values || []).length;
    if (existing > 0) return; // ya tiene datos

    await this.seedMonthSlots();
  }

  /** Genera 1 mes de horarios (30 días), 09:00–12:30 y 14:00–17:00 cada 30min, sin domingos ni feriados SCZ/BO */
  async seedMonthSlots() {
    const morning = { start: '09:00', end: '12:30' };
    const afternoon = { start: '14:00', end: '17:00' };
    const STEP_MIN = 30;

    const toAppend: any[] = [];
    const { y, m, day } = this.todayYMD();
    let cursor = new Date(Date.UTC(y, m - 1, day));

    for (let d = 0; d < 30; d++) {
      if (!this.isHolidayOrSunday(cursor)) {
        const ymd = this.ymdLocal(cursor);
        for (const slot of [
          ...this.generateTimes(morning.start, morning.end, STEP_MIN),
          ...this.generateTimes(afternoon.start, afternoon.end, STEP_MIN),
        ]) {
          // A:fecha, B:hora, C:servicio(vacío), D:estado, E:notas, F:reservado_por, G:Fecha
          toAppend.push([ymd, slot, '', 'DISPONIBLE', '', '', '']);
        }
      }
      cursor = new Date(cursor.getTime() + 24 * 60 * 60 * 1000);
    }

    if (!toAppend.length) return;

    await this.sheetsRequest(() =>
      this.sheets.spreadsheets.values.append({
        spreadsheetId: this.SPREADSHEET_ID,
        range: `${this.TAB_SLOTS}!A1:G`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        requestBody: { values: toAppend },
      })
    );
  }

  /* ================== Utilidades internas ================== */
  private async sheetsRequest<T>(fn: () => Promise<T>, attempts = this.RETRY_ATTEMPTS): Promise<T> {
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try { return await fn(); }
      catch (e) { lastErr = e; await new Promise<void>((r) => setTimeout(() => r(), this.RETRY_DELAY_MS * (i + 1))); }
    }
    throw lastErr;
  }

  private onlyDigits(s = '') { return String(s || '').replace(/[^\d]/g, ''); }

  private todayYMD(): { y: number; m: number; day: number } {
    try {
      const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: this.LOCAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
      }).formatToParts(new Date());
      const get = (t: any) => parts.find((p) => p.type === t)?.value || '';
      return { y: +get('year'), m: +get('month'), day: +get('day') };
    } catch {
      const now = new Date(); return { y: now.getFullYear(), m: now.getMonth() + 1, day: now.getDate() };
    }
  }

  private ymdLocal(d: Date): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: this.LOCAL_TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(d);
    const get = (t: any) => parts.find((p) => p.type === t)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  private generateTimes(start: string, end: string, everyMin: number): string[] {
    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);
    const out: string[] = [];
    let total = sh * 60 + sm;
    const last = eh * 60 + em;
    while (total <= last) {
      const hh = String(Math.floor(total / 60)).padStart(2, '0');
      const mm = String(total % 60).padStart(2, '0');
      out.push(`${hh}:${mm}`);
      total += everyMin;
    }
    return out;
  }

  private isHolidayOrSunday(d: Date): boolean {
    // domingo en zona local
    const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: this.LOCAL_TZ }).format(d);
    if (weekday.toLowerCase().startsWith('sun')) return true;

    const ymd = this.ymdLocal(d);
    const [y] = ymd.split('-').map(Number);
    const easter = this.easterYMD(y); // Domingo de Pascua
    const days = new Set<string>([
      // Nacionales fijos
      `${y}-01-01`, // Año Nuevo
      `${y}-05-01`, // Día del Trabajo
      `${y}-06-21`, // Año Nuevo Andino Amazónico
      `${y}-08-06`, // Independencia
      `${y}-11-02`, // Todos los Difuntos
      `${y}-12-25`, // Navidad
      // Santa Cruz (departamental)
      `${y}-09-24`,
      // Móviles (aprox. estándar BO)
      this.shiftDays(easter, -48), // Lunes Carnaval
      this.shiftDays(easter, -47), // Martes Carnaval
      this.shiftDays(easter, -2),  // Viernes Santo
      this.shiftDays(easter, +60), // Corpus Christi
    ]);
    return days.has(ymd);
  }

  /** Algoritmo de Meeus para fecha de Pascua (gregoriano). Devuelve YYYY-MM-DD */
  private easterYMD(y: number): string {
    const a = y % 19;
    const b = Math.floor(y / 100);
    const c = y % 100;
    const d = Math.floor(b / 4);
    const e = b % 4;
    const f = Math.floor((b + 8) / 25);
    const g = Math.floor((b - f + 1) / 3);
    const h = (19 * a + b - d - g + 15) % 30;
    const i = Math.floor(c / 4);
    const k = c % 4;
    const l = (32 + 2 * e + 2 * i - h - k) % 7;
    const m = Math.floor((a + 11 * h + 22 * l) / 451);
    const month = Math.floor((h + l - 7 * m + 114) / 31); // 3=Mar, 4=Abr
    const day = ((h + l - 7 * m + 114) % 31) + 1;
    return `${y}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  /** ymd +/- n días */
  private shiftDays(ymd: string, n: number): string {
    const [y, m, d] = ymd.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const shifted = new Date(dt.getTime() + n * 24 * 60 * 60 * 1000);
    return this.ymdLocal(shifted);
  }
}