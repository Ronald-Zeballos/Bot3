import { Module } from '@nestjs/common';
import { AssemblyaiService } from './assemblyai.service';

@Module({
  providers: [AssemblyaiService],
  exports: [AssemblyaiService],
})
export class AssemblyaiModule {}