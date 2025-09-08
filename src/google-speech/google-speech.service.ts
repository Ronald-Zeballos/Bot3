// src/google-speech/google-speech.service.ts

import { Injectable, InternalServerErrorException } from '@nestjs/common';
import axios from 'axios';
import { SpeechClient } from '@google-cloud/speech';
import { createWriteStream, promises as fsPromises } from 'fs'; // Use a different name for promises
import * as fs from 'fs'; // Import the standard fs module
import { join } from 'path';
import { existsSync } from 'fs';
import { protos } from '@google-cloud/speech';

@Injectable()
export class GoogleSpeechService {
  private client: SpeechClient;

  constructor() {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      try {
        const keyPath = join(__dirname, '..', '..', 'google-key.json');
        
        // CORRECTION: Use the synchronous 'fs' module for writeFileSync
        const decodedKey = Buffer.from(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON, 'base64').toString();
        fs.writeFileSync(keyPath, decodedKey);

        // Tell the Google SDK where to find the key file
        process.env.GOOGLE_APPLICATION_CREDENTIALS = keyPath;

      } catch (error) {
        console.error('Error al crear el archivo de credenciales de Google Cloud:', error);
      }
    }
    
    this.client = new SpeechClient();
  }

  async transcribeAudio(audioUrl: string): Promise<string> {
    const tempDir = join(__dirname, '..', '..', 'temp');
    const fileName = `audio-${Date.now()}.ogg`;
    const filePath = join(tempDir, fileName);

    try {
      const audioResponse = await axios.get(audioUrl, {
        responseType: 'stream',
      });

      // CORRECTION: Use fsPromises.mkdir for the async call
      await fsPromises.mkdir(tempDir, { recursive: true });

      const writer = createWriteStream(filePath);
      audioResponse.data.pipe(writer);

      await new Promise<void>((resolve, reject) => {
        writer.on('finish', () => resolve());
        writer.on('error', (err) => reject(err));
      });

      const audio = {
        // CORRECTION: Use fsPromises.readFile for the async call
        content: (await fsPromises.readFile(filePath)).toString('base64'),
      };
      
      const config = {
        encoding: protos.google.cloud.speech.v1.RecognitionConfig.AudioEncoding.OGG_OPUS,
        sampleRateHertz: 16000,
        languageCode: 'es-419',
      };

      const request = {
        audio: audio,
        config: config,
      };

      const [response] = await this.client.recognize(request);
      
      const transcription = response.results
        .map(result => result.alternatives[0].transcript)
        .join('\n');

      // CORRECTION: Use fsPromises.unlink for the async call
      await fsPromises.unlink(filePath);

      return transcription;
    } catch (error) {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath); // CORRECTION: Use fs.unlinkSync for synchronous cleanup
      }
      console.error('Error al transcribir audio con Google Cloud Speech:', error);
      throw new InternalServerErrorException('No se pudo transcribir el audio.');
    }
  }
}