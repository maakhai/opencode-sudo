# opencode-sudo

Plugin do [OpenCode](https://opencode.ai) (v2) que pede a senha do `sudo` em
uma janela TUI, mostrando **exatamente o comando que será executado**. A senha
vai direto para o `sudo`: não entra no chat, no contexto do modelo nem nos logs
do plugin.

```text
╭─ Sudo authentication ───────────────────────────────────────╮
│                                                             │
│  OpenCode wants to run as root:                             │
│                                                             │
│  sudo systemctl restart docker.service                      │
│                                                             │
│  Directory: ~/projetos/meu-projeto                          │
│  Session: minha-sessão · usuário@host                       │
│                                                             │
│  Password: ••••••••••                                       │
│                                                             │
│  enter authorize   esc cancel                               │
╰─────────────────────────────────────────────────────────────╯
```

## Por que existe

O shell tool do OpenCode roda sem TTY. Quando o agente chama `sudo`, o sudo não
tem onde pedir a senha e falha com `a terminal is required to authenticate`.
Este plugin cria um `SUDO_ASKPASS` local e mostra um modal no TUI para você
autorizar o comando sem colar a senha na conversa.

## Recursos

- Mostra o comando **real** lido de `/proc/<pid-do-sudo>/cmdline` e o diretório
  em `/proc/<pid>/cwd`. Funciona até quando o `sudo` está dentro de um script
  (`make install` → a janela mostra o `sudo apt install ...` interno).
- Campo de senha mascarado (`•`); `enter` autoriza, `esc` cancela.
- Valida a senha com `sudo -k -A -v` antes de liberar. Senha errada mostra o
  erro na própria janela e deixa tentar de novo.
- Cache em memória de 15 minutos; a janela aparece quando o sudo realmente
  pediria senha, como no desktop.
- Política `on` / `ask` / `off` e bloqueio manual pelo `/sudo`.
- Sem TUI (`opencode run`), o sudo é negado com mensagem clara; não existe
  fallback de senha em arquivo.
- Redige a senha se ela aparecer por acidente em uma saída de ferramenta ou no
  prompt do usuário.

## Requisitos

- OpenCode v2 (testado com 2.2.x).
- Linux com `sudo` (testado com `sudo-rs`).
- Python 3 no host — o askpass é um script Python sem dependências.
- O TUI do OpenCode. `opencode run` não tem como mostrar a janela.

## Instalação

Clone o repositório em qualquer diretório (troque `<seu-usuario>` pelo dono
do repositório):

```sh
git clone https://github.com/<seu-usuario>/opencode-sudo.git ~/projetos/opencode-sudo
```

Adicione o plugin ao `~/.config/opencode/opencode.jsonc` global. Ajuste o
caminho para onde você clonou:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "/caminho/para/opencode-sudo",
      "options": {
        "policy": "on",
        "timeout": 120,
        "ttl": 900,
        "validate": true,
        "notify": true,
        "audit": false
      }
    }
  ],
}
```

Verifique se o plugin foi carregado:

```sh
opencode plugin list
```

A saída deve incluir `opencode-sudo`. Se o comando não aparecer no TUI, rode
`/reload` ou reinicie o serviço com `opencode service restart`.

Não há etapa de build: o OpenCode transpila `src/index.ts` e `src/tui.tsx` em
tempo de carga. O `@opencode/plugin` é resolvido pelo runtime do OpenCode.

## Uso

O agente usa `sudo` normalmente. No primeiro comando que precisar de senha, a
janela aparece. Para testar sem risco:

> Peça ao agente para rodar `sudo -k true`.

A janela mostra o comando; digite a senha e o comando roda como root. O
resultado volta para o agente, mas a senha não.

### Comandos no TUI

| Comando | Efeito |
| --- | --- |
| `/sudo` ou `/sudo status` | mostra política, TUI, cache, pendentes e instância |
| `/sudo on` | janela quando o sudo pedir senha (padrão) |
| `/sudo ask` | janela em **todo** comando sudo (o shim adiciona `-k`) |
| `/sudo off` | nega qualquer comando com sudo antes de executar |
| `/sudo lock` | limpa o cache e roda `sudo -K` para zerar o timestamp |

O `/sudo` não envia o texto digitado para a conversa. Mesmo assim, **nunca
digite a senha depois de `/sudo `** — use o campo da janela.

### Sem TUI

`opencode run` (ou qualquer servidor sem TUI) não consegue sudo. O comando
falha em ~1s com:

```text
sudo requires interactive authentication in the OpenCode TUI. Run OpenCode in
a terminal (not `opencode run`), or configure NOPASSWD for specific commands.
```

Se você precisa de automação headless, a alternativa é uma lista curta de
`NOPASSWD` no sudoers — fora do escopo do plugin.

## Configuração

| Opção | Padrão | Descrição |
| --- | --- | --- |
| `policy` | `on` | `on` (quando o sudo pedir), `ask` (todo comando), `off` (nega) |
| `timeout` | `120` | segundos que a janela espera a resposta |
| `ttl` | `900` | segundos do cache em memória (15 min) |
| `validate` | `true` | valida com `sudo -k -A -v` antes de liberar |
| `notify` | `true` | notificação/som quando a janela abre sem foco |
| `audit` | `false` | grava um JSONL em `~/.local/state/opencode-sudo/audit.jsonl` |

O `audit` registra comando, cwd, sessão, decisão e horário; **nunca** a senha.

A política também pode ser alterada pelo arquivo
`~/.config/opencode/sudo-policy` (`on`, `ask` ou `off`). A variável
`OPENCODE_SUDO_POLICY` tem precedência sobre o arquivo e sobre a opção.

## Como funciona

```text
agente → shell tool → bin/sudo (shim) → /usr/bin/sudo -A
                                           │
                                     SUDO_ASKPASS
                                           │
                                    askpass.py → socket 0600
                                           │
                                    server do plugin
                                           │
                              lê /proc/<pid>/cmdline + cwd
                                           │
                                    TUI modal (RPC)
                                           │
                              valida com sudo -k -A -v
                                           │
                                    devolve a senha ao sudo
```

- **Server** (`src/index.ts`): singleton compartilhado entre as locations do
  mesmo processo; cria o runtime em
  `$XDG_RUNTIME_DIR/opencode-sudo/<pid>-<random>/` (0700), com `bin/sudo`,
  `askpass.py` e `agent.sock` (0600). Registra os hooks de shell, permissão,
  ferramenta e prompt, e mantém o cache em memória.
- **RPC** (`src/rpc.ts`): `hello`, `pending`, `unlock`, `cancel`, `lock`,
  `status`, `setPolicy`; evento `need`.
- **TUI** (`src/tui.tsx`): heartbeat a cada 2s, polling de `pending` a cada 1s,
  modal customizado (o `dialog.prompt` do OpenCode 2.2.5 não tem máscara),
  fila, notificação e o comando `/sudo`.
- **Validação**: o servidor gera um helper askpass temporário com um nonce,
  roda `sudo -k -A -v` e só libera a senha se o exit code for 0. O helper
  temporário é removido em seguida.
- **Redação**: a senha em cache é substituída por `[REDACTED]` em resultados de
  ferramentas e prompts. É uma proteção contra acidente; a senha nunca é
  escrita no disco.

## Segurança

- A senha fica em memória no TUI e no processo do servidor, e passa pelo socket
  local (0600) até o askpass. Não é gravada em disco, na sessão ou no
  histórico do modelo.
- O plugin é um **gate de UX e de vazamento acidental**, não uma fronteira de
  privilégio. O agente roda com o seu usuário; se ele estiver em grupos como
  `docker` ou `lxd`, já consegue root efetivo por outros caminhos. Para uma
  fronteira real, seria preciso sandbox/remover esses grupos.
- O comando mostrado vem de `/proc`, não do texto do modelo. Ainda assim, o
  agente controla o comando; leia a janela antes de autorizar.
- O RPC TUI↔servidor é HTTP em `127.0.0.1`. Não use o unlock por TUI conectada a
  um servidor remoto sem TLS.
- O cache de 15 min significa que, dentro dessa janela, novos `sudo` podem rodar
  sem nova janela. Use `/sudo ask` para exigir confirmação em todo comando ou
  `/sudo lock` para encerrar a janela.
- O plugin vale para o shell tool do OpenCode. Servidores MCP, terminais
  externos e o modo shell `!` do TUI não herdam o shim.

## Desenvolvimento

```sh
node --test test/*.test.js
```

Testes atuais: scanner de `sudo` em posição de comando, parse/quote do
`/proc/<pid>/cmdline`, precedência da política, arquivo de estado e redação.

Teste manual completo:

1. `opencode plugin list` mostra `opencode-sudo`.
2. Peça ao agente `sudo -k true`; a janela abre com o comando e o campo `•••`.
3. Digite a senha; o comando roda e o agente recebe o resultado.
4. Senha errada: a janela mostra “incorrect password” e deixa tentar de novo.
5. `esc`: o comando falha com “cancelled by user”.
6. `/sudo lock`: o cache zera; o próximo sudo pede de novo.
7. `/sudo off`: o comando é negado antes de executar.
8. `opencode run "rode sudo -n true"`: falha rápido com a mensagem de sem TUI.

## Estrutura

```text
opencode-sudo/
  package.json
  README.md
  src/
    index.ts      server plugin (singleton, hooks, RPC handlers)
    tui.tsx       modal mascarado, polling e /sudo
    rpc.ts        contrato RPC
    runtime.ts    runtime dir, shim, askpass e socket Unix
    command.js    parse/format do /proc
    policy.js     on/ask/off e state file
    scanner.js    detecção de sudo em posição de comando
    redact.js     redação da senha
  test/
    scanner.test.js
    command.test.js
    policy.test.js
    redact.test.js
```

## Licença

MIT. O `src/scanner.js` é adaptado do
[fitzypopper/opencode-sudo-plugin](https://github.com/fitzypopper/opencode-sudo-plugin)
(MIT); o restante é MIT.
