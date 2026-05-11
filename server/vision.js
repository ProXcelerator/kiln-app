/**
 * Analyzes a given cone image using the Gemini REST API to estimate the bend and maturity.
 * @param {string} base64Data Raw base64 string of the image (without data uri prefix)
 * @param {string} mimeType Mime type of the image (e.g. 'image/jpeg')
 * @param {string} apiKey Gemini API Key
 * @param {string} targetCone The expected cone number (e.g. '04', '6')
 */
async function analyzeConeImage(base64Data, mimeType, apiKey, targetCone = '') {
  if (!apiKey) {
    throw new Error('No Gemini API Configured.');
  }

  const coneContext = targetCone ? `The user specifies this is an Orton Cone ${targetCone}. Evaluate it under that context.` : '';
  const prompt = `
You are an expert ceramist and kiln technician strictly evaluating the heat-work on an Orton witness cone. 
Examine the provided image of a witness cone after firing. ${coneContext} 
Your output must be strictly valid JSON data without any markdown wrappers or text outside the curly braces.

Use the following schema:
{
  "estimatedBend": "String estimating the clock face or degree bend (e.g. '3 oclock', '90 degrees', 'touching toes')",
  "maturity": "One of: ['underfired', 'perfect', 'overfired']",
  "analysis": "A brief 2-sentence explanation of your assessment."
}

If you cannot see a cone, output:
{
  "estimatedBend": "Unknown",
  "maturity": "underfired",
  "analysis": "No valid ceramics witness cone clearly detected in the image."
}
`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inline_data: { mime_type: mimeType, data: base64Data } }
      ]
    }]
  };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error?.message || 'Failed to call Gemini Vision API');
  }

  try {
    const textRes = data.candidates[0].content.parts[0].text;
    const jsonString = textRes.replace(/^```json/i, '').replace(/```$/i, '').trim();
    return JSON.parse(jsonString);
  } catch (err) {
    console.error('Failed to parse Gemini output:', err.message, data);
    throw new Error('AI returned an invalid response format.');
  }
}

module.exports = {
  analyzeConeImage
};
