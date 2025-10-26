// src/assemblyai/assemblyai.service.ts

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';
import { createReadStream, promises as fs } from 'fs'; // <-- This is the corrected import
import { join } from 'path';

@Injectable()
export class AssemblyaiService {
  // Ahora el endpoint es para subir archivos, no para crear transcripciones por URL
  private readonly API_UPLOAD_URL = 'https://api.assemblyai.com/v2/upload';
  // Este es el endpoint para crear la transcripción una vez que el archivo ha sido subido
  private readonly API_TRANSCRIPT_URL = 'https://api.assemblyai.com/v2/transcript';
  
  private readonly HEADERS_UPLOAD = {
    'authorization': process.env.ASSEMBLYAI_API_KEY,
    'Content-Type': 'application/octet-stream', // Necesario para subir datos binarios
  };
  private readonly HEADERS_TRANSCRIPT = {
    'authorization': process.env.ASSEMBLYAI_API_KEY,
    'Content-Type': 'application/json',
  };

  async transcribeAudio(audioUrl: string): Promise<string> {
    const tempDir = join(__dirname, '..', '..', 'temp');
    const fileName = `audio-${Date.now()}.ogg`;
    const filePath = join(tempDir, fileName);

    try {
      // 1. Descargar el archivo de audio desde la URL temporal de Meta
      const audioResponse = await axios.get(audioUrl, {
        responseType: 'stream'
      });

      // Crear el directorio temporal si no existe
      await fs.mkdir(tempDir, { recursive: true });

      // Guardar el archivo en una ubicación temporal
      const writer = require('fs').createWriteStream(filePath); // <-- Use require for the standard fs module
      audioResponse.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      // 2. Subir el archivo directamente a AssemblyAI
      const fileStream = createReadStream(filePath);
      const uploadResponse = await axios.post(this.API_UPLOAD_URL, fileStream, {
        headers: this.HEADERS_UPLOAD,
      });

      const uploadUrl = uploadResponse.data.upload_url;
      
      // 3. Crear una solicitud de transcripción usando la URL de subida
      const transcriptRequestData = {
        audio_url: uploadUrl,
      };
      
      const transcriptResponse = await axios.post(this.API_TRANSCRIPT_URL, transcriptRequestData, {
        headers: this.HEADERS_TRANSCRIPT,
      });

      const transcriptId = transcriptResponse.data.id;
      let status = 'queued';
      let resultText = '';

      // 4. Polling: esperar el resultado de la transcripción
      while (status !== 'completed' && status !== 'error') {
        const pollResponse = await axios.get(`${this.API_TRANSCRIPT_URL}/${transcriptId}`, {
          headers: { 'authorization': process.env.ASSEMBLYAI_API_KEY },
        });
        status = pollResponse.data.status;
        if (status === 'completed') {
          resultText = pollResponse.data.text;
        }
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // 5. Limpiar el archivo temporal
      await fs.unlink(filePath);
      
      if (status === 'error') {
        throw new Error('Error al transcribir el audio en AssemblyAI.');
      }

      return resultText;
    } catch (error) {
      // Limpiar el archivo en caso de error para evitar acumulación
      if (require('fs').existsSync(filePath)) {
        await fs.unlink(filePath);
      }
      console.error('Error al transcribir audio con AssemblyAI:', error.response?.data?.error || error.message);
      throw new InternalServerErrorException('No se pudo transcribir el audio.');
    }
  }
}