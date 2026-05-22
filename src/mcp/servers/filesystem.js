export function register(server) {
  server.registerTool('filesystem_list', async ({ path = '.' }) => {
    const { readdir } = await import('fs/promises');
    const files = await readdir(path);
    return { content: files.join('\n') };
  }, {
    description: 'List directory contents'
  });
  
  server.registerTool('filesystem_stat', async ({ path }) => {
    const { stat } = await import('fs/promises');
    const info = await stat(path);
    return { content: JSON.stringify(info, null, 2) };
  }, {
    description: 'Get file/directory info'
  });
  
  server.registerPrompt('analyze_code', `Analizza il seguente codice e identifica potenziali problemi:
{{code}}

Cerca:
- Bug
- Security issues
- Code smells
- Performance problems`, 'Analizza codice per problemi');
}