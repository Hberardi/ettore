export default {
  description: 'Show history',
  aliases: ['hist'],
  handler: async (args, context) => {
    const history = context.history || [];
    if (history.length === 0) return 'No history yet';
    
    const limit = parseInt(args[0]) || 10;
    return history.slice(-limit).map((h, i) => `${i + 1}: ${h}`).join('\n');
  }
};