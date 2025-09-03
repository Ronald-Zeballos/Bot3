import { Injectable, InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';

@Injectable()
export class AssemblyaiService {
  private readonly API_URL = 'https://api.assemblyai.com/v2/transcript';
  private readonly HEADERS = {
    'authorization': process.env.ASSEMBLYAI_API_KEY,
    'Content-Type': 'application/json',
  };

  async transcribeAudio(audioUrl: string): Promise<string> {
    try {
      const response = await axios.post(this.API_URL, {
        audio_url: audioUrl,
      }, { headers: this.HEADERS });

      const transcriptId = response.data.id;
      let status = 'queued';
      let resultText = '';

      // Poll the API to check the transcription status
      while (status !== 'completed' && status !== 'error') {
        const transcriptResponse = await axios.get(`${this.API_URL}/${transcriptId}`, {
          headers: this.HEADERS,
        });
        status = transcriptResponse.data.status;
        if (status === 'completed') {
          resultText = transcriptResponse.data.text;
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before re-checking
      }

      if (status === 'error') {
        throw new Error('Error al transcribir el audio en AssemblyAI.');
      }

      return resultText;
    } catch (error) {
      console.error('Error al transcribir audio con AssemblyAI:', error);
      throw new InternalServerErrorException('No se pudo transcribir el audio.');
    }
  }
}