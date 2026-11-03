const fs = require('fs');
const CHANNELS = Object.freeze([
  { code: 'SE', id: '1', culture: 'sv-SE', country: 'SE', currency: 'SEK' },
  { code: 'NO', id: '2', culture: 'nb-NO', country: 'NO', currency: 'NOK' },
  { code: 'DK', id: '3', culture: 'da-DK', country: 'DK', currency: 'DKK' },
  { code: 'FI', id: '4', culture: 'fi-FI', country: 'FI', currency: 'EUR' },
  { code: 'DE', id: '5', culture: 'de-DE', country: 'DE', currency: 'EUR' },
  { code: 'EU', id: '6', culture: 'en-GB', country: 'BE', currency: 'EUR' },
  { code: 'NL', id: '7', culture: 'nl-NL', country: 'NL', currency: 'EUR' },
  { code: 'AT', id: '8', culture: 'de-DE', country: 'AT', currency: 'EUR' },
]);

function selectedChannels(id, channels = CHANNELS) {
  if (!id) return channels;
  const selected = channels.filter(channel => channel.id === String(id) || channel.code === String(id).toUpperCase());
  if (!selected.length) throw new Error(`Unknown Norce channel: ${id}`);
  return selected;
}

function channelsFromFile(file) {
  if (!file) return CHANNELS;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const rows = Array.isArray(data) ? data : data.suggestedChannels;
  if (!Array.isArray(rows) || !rows.length) throw new Error('Channel file must contain a nonempty channel array or suggestedChannels.');
  const channels = rows.map(row => ({ code: String(row.code || ''), id: String(row.id || ''), culture: String(row.culture || ''), country: String(row.country || ''), currency: String(row.currency || '') }));
  if (channels.some(row => !row.id || !row.culture || !row.country || !row.currency) || new Set(channels.map(row => row.id)).size !== channels.length) {
    throw new Error('Channel file has missing context fields or duplicate channel IDs.');
  }
  return channels;
}

module.exports = { CHANNELS, selectedChannels, channelsFromFile };
