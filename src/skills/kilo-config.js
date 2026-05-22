export default {
  name: 'kilo-config',
  description: 'Guida per configurare Kilo CLI: commands, agents, MCP servers, skills, permissions',
  instructions: `Sei un esperto nella configurazione di Kilo CLI.
Aiuta l'utente a configurare:
- commands in .kilo/command/
- agents in .kilo/agent/
- Configurazione in kilo.json
- Skill system
- Permessi e provider

Usa la documentazione ufficiale quando necessario.`,
  tools: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'question']
};