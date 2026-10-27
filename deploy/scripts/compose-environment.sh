#!/usr/bin/env bash

# Shared remote Compose invocation and runtime-resolved service-set policy.
compose_with_deployment_environment() {
  local stack="$1"
  local env_file="$2"
  local compose_file="$3"
  local variable_name
  local -a clean_environment=("HOME=${HOME}" "PATH=${PATH}")
  shift 3

  for variable_name in \
    DOCKER_API_VERSION \
    DOCKER_CERT_PATH \
    DOCKER_CONFIG \
    DOCKER_CONTEXT \
    DOCKER_CUSTOM_HEADERS \
    DOCKER_DEFAULT_PLATFORM \
    DOCKER_HOST \
    DOCKER_TLS \
    DOCKER_TLS_VERIFY \
    BUILDX_BUILDER \
    BUILDX_CONFIG \
    BUILDKIT_HOST; do
    if [[ "${!variable_name+x}" == x ]]; then
      clean_environment+=("${variable_name}=${!variable_name}")
    fi
  done

  env -i "${clean_environment[@]}" \
    docker compose --project-name "$stack" --env-file "$env_file" -f "$compose_file" "$@" </dev/null
}

platform_services_for_omp_runtime() {
  case "$1" in
    true)
      ;;
    false)
      ;;
    *)
      printf 'Invalid OMP runtime flag: %s\n' "$1" >&2
      return 1
      ;;
  esac
  printf '%s\n' postgres redis api worker web mcp-readonly model-tunnel task-adapter-reference gateway
  if [[ "$1" == true ]]; then
    printf '%s\n' sandbox-broker
  fi
}
