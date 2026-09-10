import { saveArtifact } from '../src/artifact/store.js';
import { sampleBalanceArtifact } from '../test/fixtures/sample-artifact.js';
console.log('saved:', saveArtifact(sampleBalanceArtifact()));
