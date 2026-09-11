import { GoogleGenAI } from '@google/genai';
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

async function test() {
  try {
    const apiKey = process.env.AI_INTEGRATIONS_GEMINI_API_KEY;
    
    if (!apiKey) {
      console.error('API key should be set when using the Gemini API.');
      return;
    }
    
    console.log('API Key loaded:', apiKey ? 'Yes' : 'No');
    
    // Test direct API call
    console.log('Testing direct API call...');
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await response.json();
    
    if (response.ok) {
      console.log('API call successful!');
      console.log('Available models:', data.models?.slice(0, 3).map((m: any) => m.name));
    } else {
      console.error('API call failed:', data);
    }
    
    return;
    
    return;
    
    const systemInstruction = `You are the "Synthetic Lexicon Engine," an elite multi-agent AI replicating the world's top naming agencies (like Lexicon Branding). Your goal is to create "Unicorn Names"—category-defining, highly acquirable brand names.

The Unicorn Protocol (Mandatory for every request):

Phase 1: The Semantic Shift (The "Apple" Strategy)
* Take a familiar, comforting word and apply it to a completely unrelated, high-tech or complex industry to create approachability and intrigue.

Phase 2: Morphemic Blending (The "Swiffer/Pentium" Strategy)
* Combine a functional root with an emotional suffix.
* Use classical Latin/Greek roots, but morph them so they feel modern and frictionless.

Phase 3: The Empty Vessel (The "Kodak" Strategy)
* Create a 100% coined word (5-7 letters maximum).
* Prioritize "Power Letters" (P, K, B, D, V, Z, X) and strict CV-CV (Consonant-Vowel) frameworks for maximum cognitive processing fluency and global pronounceability.
* These have the highest probability of .com availability.

Phase 4: Metaphorical Mapping
* Find a physical object, natural phenomenon, or scientific principle that perfectly represents the Ultimate Emotional Benefit of the product, and use it as the name.

Phase 5: The Validation & Acquisition Filter
* For each name, provide:
  1. The Origin (Which strategy was used).
  2. The Phonetic Score (1-10 on pronounceability).
  3. The Billboard Test (Visual & Slogan).
* CRITICAL: ONLY suggest names that have a high probability of being legally clear and having an acquirable .com domain. Avoid common dictionary words unless combined uniquely.

User Interaction Style: Be cerebral, authoritative, and disruptive. Format your output clearly using Markdown with distinct sections for each phase.`;

    const productDescription = 'A direct-to-consumer brand selling sustainable, minimalist everyday carry items.';
    const targetAudience = 'Urban millennials, design enthusiasts';
    const additionalContext = 'Focus on sustainability, minimalism, and modern lifestyle. Avoid overly technical terms.';

    const prompt = `Product Description: ${productDescription}\nTarget Audience: ${targetAudience}\nAdditional Context: ${additionalContext}\n\nExecute the Unicorn Protocol.`;
    
    const temperature = 1.0;

    const stream = await ai.models.generateContentStream({
      model: 'gemini-1.5-flash',
      contents: prompt,
      config: {
        systemInstruction,
        temperature,
      }
    });

    let fullResponse = '';
    for await (const chunk of stream) {
      fullResponse += chunk.text;
    }
    console.log('Success! Length:', fullResponse.length);
  } catch (e) {
    console.error('Error:', e);
  }
}
test();
