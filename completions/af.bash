# bash completion for aflt (aliases: af, agentfleet)
_af_session_titles() {
  local home reg
  home="${AGENTFLEET_HOME:-$HOME/.agentfleet}"
  reg="${AGENTFLEET_REGISTRY:-$home/sessions.json}"
  if [[ ! -f "$reg" ]]; then
    return 0
  fi
  # Prefer node (af already requires it); fall back to empty
  node -e '
    try {
      const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      for (const s of d.sessions || []) {
        if (s && s.title) process.stdout.write(s.title + "\n");
      }
    } catch (_) {}
  ' "$reg" 2>/dev/null
}

_af_copilot_session_ids() {
  local root
  if [[ -n "${AGENTFLEET_COPILOT_HOME:-}" ]]; then
    root="${AGENTFLEET_COPILOT_HOME}/session-state"
  elif [[ -n "${COPILOT_HOME:-}" ]]; then
    root="${COPILOT_HOME}/session-state"
  else
    root="${HOME}/.copilot/session-state"
  fi
  if [[ ! -d "$root" ]]; then
    return 0
  fi
  # Cheap: directory names are session UUIDs (no file reads)
  local d
  for d in "$root"/*; do
    [[ -d "$d" ]] || continue
    basename "$d"
  done 2>/dev/null
}

_af() {
  local cur prev cmds titles
  COMPREPLY=()
  cur="${COMP_WORDS[COMP_CWORD]}"
  prev="${COMP_WORDS[COMP_CWORD-1]}"
  cmds="version new init add import ls list timeline projects dashboard making-of memory sync run log spawn master docs children result wait tail send stop resume pick adopt cursor copilot opencode engine rename cwd set-cwd done rm remove purge orphans note export import-file which-backend setup herdr-templates herdr-app doctor msg inbox thread mcp help turns archive unarchive loop notify service space eval"

  if [[ ${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "${cmds}" -- "${cur}") )
    return 0
  fi

  case "${COMP_WORDS[1]}" in
    resume|pick)
      COMPREPLY=( $(compgen -W "--all --via --tag --dry-run --tmux-session --here --open --no-open --no-herdr-app --prompt --force --interactive -i tmux iterm2 wezterm herdr plain" -- "${cur}") )
      ;;
    adopt)
      COMPREPLY=( $(compgen -W "--all --dry-run --json" -- "${cur}") )
      ;;
    new|add)
      COMPREPLY=( $(compgen -W "--cwd --prompt --model --tag --chat --engine --project --force --messaging --no-messaging --dry-run --no-trust cursor copilot opencode" -- "${cur}") )
      ;;
    init)
      COMPREPLY=( $(compgen -W "--dir --space --no-space --engine --goal --stack --checks --budget-credits --budget-hours --yes --existing --isolated --force --json cursor copilot opencode" -- "${cur}") )
      ;;
    run)
      COMPREPLY=( $(compgen -W "--prompt --cwd --model --engine --project --mode --force --output-format --timeout --messaging --no-messaging --no-docs --dry-run --json --no-trust --no-silent cursor copilot opencode ask plan text json" -- "${cur}") )
      ;;
    spawn)
      if [[ "$prev" == "--parent" ]]; then
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "${titles}" -- "${cur}") )
      else
        COMPREPLY=( $(compgen -W "--parent --prompt --engine --cwd --project --title --task --model --timeout --force --interactive --detach --messaging --no-messaging --dry-run --json --no-trust cursor copilot opencode" -- "${cur}") )
      fi
      ;;
    master)
      COMPREPLY=( $(compgen -W "--goal --engine --cwd --title --model --project --worker-engine --headless --timeout --force --messaging --no-messaging --no-docs --dry-run --json --no-trust cursor copilot opencode" -- "${cur}") )
      ;;
    docs)
      COMPREPLY=( $(compgen -W "--status --all --since --engine --model --force --no-force --anyway --dry-run --json --cwd --timeout cursor copilot opencode" -- "${cur}") )
      ;;
    msg)
      if [[ "$prev" == "--from" || "$prev" == "--reply" || "$prev" == "--type" ]]; then
        if [[ "$prev" == "--type" ]]; then
          COMPREPLY=( $(compgen -W "question answer note blocked" -- "${cur}") )
        else
          titles="$(_af_session_titles)"
          COMPREPLY=( $(compgen -W "${titles}" -- "${cur}") )
        fi
      elif [[ ${COMP_CWORD} -eq 2 ]]; then
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "enable disable master all-siblings --type --reply --from --json --dry-run ${titles}" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--type --reply --from --json --dry-run master all-siblings ${titles}" -- "${cur}") )
      fi
      ;;
    inbox)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--unread --mark-read --json" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--unread --mark-read --json ${titles}" -- "${cur}") )
      fi
      ;;
    thread)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--json" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--json ${titles}" -- "${cur}") )
      fi
      ;;
    mcp)
      if [[ ${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "install" -- "${cur}") )
      elif [[ "$prev" == "--engine" ]]; then
        COMPREPLY=( $(compgen -W "copilot cursor" -- "${cur}") )
      else
        COMPREPLY=( $(compgen -W "--engine --write --project --cwd --dry-run --json copilot cursor" -- "${cur}") )
      fi
      ;;
    result)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--path --json --require-fresh" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "${titles}" -- "${cur}") )
      fi
      ;;
    children)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--json --all" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--json --all ${titles}" -- "${cur}") )
      fi
      ;;
    wait)
      if [[ "$prev" == "--parent" ]]; then
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "${titles}" -- "${cur}") )
      elif [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--parent --any --timeout --interval --send-grace --docs --json" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--parent --any --timeout --interval --send-grace --docs --json ${titles}" -- "${cur}") )
      fi
      ;;
    tail)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "-n -f --follow" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "-n -f --follow ${titles}" -- "${cur}") )
      fi
      ;;
    send)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--timeout --force --json --no-trust" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--timeout --force --no-trust ${titles}" -- "${cur}") )
      fi
      ;;
    stop)
      if [[ "$cur" == -* || "$prev" == "--all-children" ]]; then
        if [[ "$prev" == "--all-children" ]]; then
          titles="$(_af_session_titles)"
          COMPREPLY=( $(compgen -W "${titles}" -- "${cur}") )
        else
          COMPREPLY=( $(compgen -W "--all-children --json" -- "${cur}") )
        fi
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--all-children --json ${titles}" -- "${cur}") )
      fi
      ;;
    rm|remove)
      if [[ "$prev" == "--children" ]]; then
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "${titles}" -- "${cur}") )
      elif [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--children --with-master --keep-files --force --dry-run" -- "${cur}") )
      else
        titles="$(_af_session_titles)"
        COMPREPLY=( $(compgen -W "--children --with-master --keep-files --force --dry-run ${titles}" -- "${cur}") )
      fi
      ;;
    engine)
      COMPREPLY=( $(compgen -W "cursor copilot opencode" -- "${cur}") )
      ;;
    log)
      COMPREPLY=( $(compgen -W "--path" -- "${cur}") )
      ;;
    herdr-templates)
      COMPREPLY=( $(compgen -W "--force --dry-run" -- "${cur}") )
      ;;
    setup)
      COMPREPLY=( $(compgen -W "--apply --json --herdr --memory --force" -- "${cur}") )
      ;;
    doctor)
      COMPREPLY=( $(compgen -W "--json" -- "${cur}") )
      ;;
    cwd|set-cwd)
      if [[ ${COMP_CWORD} -eq 2 ]]; then
        if [[ "$cur" == -* ]]; then
          COMPREPLY=( $(compgen -W "--dry-run --json" -- "${cur}") )
        else
          titles="$(_af_session_titles)"
          COMPREPLY=( $(compgen -W "--dry-run --json ${titles}" -- "${cur}") )
        fi
      elif [[ ${COMP_CWORD} -eq 3 ]]; then
        if [[ "$cur" == -* ]]; then
          COMPREPLY=( $(compgen -W "--dry-run --json" -- "${cur}") )
        else
          COMPREPLY=( $(compgen -d -- "${cur}") )
        fi
      else
        COMPREPLY=( $(compgen -W "--dry-run --json" -- "${cur}") )
      fi
      ;;
    herdr-app)
      if [[ ${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "install status" -- "${cur}") )
      else
        COMPREPLY=( $(compgen -W "--copy --force --dry-run" -- "${cur}") )
      fi
      ;;
    ls|list)
      COMPREPLY=( $(compgen -W "--status --tag --project --all --json --archived --space" -- "${cur}") )
      ;;
    timeline)
      COMPREPLY=( $(compgen -W "--all --json --since --project" -- "${cur}") )
      ;;
    projects)
      COMPREPLY=( $(compgen -W "--json --project" -- "${cur}") )
      ;;
    dashboard)
      COMPREPLY=( $(compgen -W "--serve --port --host --snapshot --json --capture-completions --space" -- "${cur}") )
      ;;
    making-of)
      COMPREPLY=( $(compgen -W "--out --data --serve --port --host --build-url --build-label --seed --repo --no-diffs --with-files --json --space" -- "${cur}") )
      ;;
    memory)
      if [[ ${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "where init sync dashboard config refresh doc status" -- "${cur}") )
      elif [[ "${COMP_WORDS[2]}" == "init" ]]; then
        COMPREPLY=( $(compgen -W "--force --json" -- "${cur}") )
      elif [[ "${COMP_WORDS[2]}" == "sync" ]]; then
        COMPREPLY=( $(compgen -W "--all --include-adhoc --dry-run --json --no-redact --active-days --commit --push" -- "${cur}") )
      elif [[ "${COMP_WORDS[2]}" == "dashboard" ]]; then
        COMPREPLY=( $(compgen -W "--dry-run --json --no-redact --active-days --include-adhoc" -- "${cur}") )
      elif [[ "${COMP_WORDS[2]}" == "config" || "${COMP_WORDS[2]}" == "refresh" ]]; then
        COMPREPLY=( $(compgen -W "--apply --json --no-redact --active-days --commit --push" -- "${cur}") )
      elif [[ "${COMP_WORDS[2]}" == "doc" ]]; then
        COMPREPLY=( $(compgen -W "--engine --dry-run --json --force cursor copilot opencode" -- "${cur}") )
      elif [[ "${COMP_WORDS[2]}" == "status" || "${COMP_WORDS[2]}" == "where" ]]; then
        COMPREPLY=( $(compgen -W "--json" -- "${cur}") )
      else
        COMPREPLY=( $(compgen -W "where init sync dashboard config refresh doc status --json" -- "${cur}") )
      fi
      ;;
    sync)
      COMPREPLY=( $(compgen -W "--dry-run --json" -- "${cur}") )
      ;;
    loop)
      if [[ ${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "init validate run start pause status stop resume approve" -- "${cur}") )
      elif [[ "${COMP_WORDS[2]}" == "init" ]]; then
        COMPREPLY=( $(compgen -W "--engine --model --build-model --plan-model --out --dry-run --force --no-gate --no-dashboard --no-agents-pointer --budget-credits --budget-hours --isolated --json" -- "${cur}") )
      elif [[ "${COMP_WORDS[2]}" == "validate" || "${COMP_WORDS[2]}" == "start" ]]; then
        COMPREPLY=( $(compgen -W "--json" -- "${cur}") )
      elif [[ "${COMP_WORDS[2]}" == "run" ]]; then
        COMPREPLY=( $(compgen -W "--dry-run --json --fresh" -- "${cur}") )
      elif [[ "${COMP_WORDS[2]}" == "status" || "${COMP_WORDS[2]}" == "stop" || "${COMP_WORDS[2]}" == "resume" || "${COMP_WORDS[2]}" == "pause" || "${COMP_WORDS[2]}" == "approve" ]]; then
        COMPREPLY=( $(compgen -W "--json --force" -- "${cur}") )
      else
        COMPREPLY=( $(compgen -W "init validate run start pause status stop resume approve --json --dry-run" -- "${cur}") )
      fi
      ;;
    service)
      if [[ ${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "install uninstall status" -- "${cur}") )
      else
        COMPREPLY=( $(compgen -W "--port --host --print --json --space install uninstall status" -- "${cur}") )
      fi
      ;;
    space)
      if [[ ${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "list ls create current remove" -- "${cur}") )
      elif [[ "${COMP_WORDS[2]}" == "create" || "${COMP_WORDS[2]}" == "remove" ]]; then
        COMPREPLY=( $(compgen -W "--json --force --space" -- "${cur}") )
      else
        COMPREPLY=( $(compgen -W "list ls create current remove --json --force --space" -- "${cur}") )
      fi
      ;;
    notify)
      COMPREPLY=( $(compgen -W "test --json" -- "${cur}") )
      ;;
    eval)
      if [[ ${COMP_CWORD} -eq 2 ]]; then
        COMPREPLY=( $(compgen -W "measure score report gate plateau" -- "${cur}") )
      else
        case "${COMP_WORDS[2]}" in
          measure)
            COMPREPLY=( $(compgen -W "--json --out" -- "${cur}") )
            ;;
          score)
            COMPREPLY=( $(compgen -W "--json --history --qualitative --results-dir --write-baseline --max-rounds" -- "${cur}") )
            ;;
          report)
            COMPREPLY=( $(compgen -W "--json --history --limit" -- "${cur}") )
            ;;
          gate)
            COMPREPLY=( $(compgen -W "--json --base --paths --improve --baseline --results --results-dir --history --score" -- "${cur}") )
            ;;
          plateau)
            COMPREPLY=( $(compgen -W "--json --baseline --history --max-rounds --rounds" -- "${cur}") )
            ;;
          *)
            COMPREPLY=( $(compgen -W "--json" -- "${cur}") )
            ;;
        esac
      fi
      ;;
    import)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--engine --cwd --limit --json --title --tag --project --all --dry-run --allow-missing --pick -i cursor copilot" -- "${cur}") )
      elif [[ "$prev" == "--engine" ]]; then
        COMPREPLY=( $(compgen -W "cursor copilot" -- "${cur}") )
      else
        local ids
        ids="$(_af_copilot_session_ids)"
        COMPREPLY=( $(compgen -W "cursor copilot --engine --cwd --limit --json --title --tag --project --all --dry-run --allow-missing --pick -i ${ids}" -- "${cur}") )
      fi
      ;;
  esac
}
complete -F _af af
complete -F _af agentfleet
complete -F _af aflt
