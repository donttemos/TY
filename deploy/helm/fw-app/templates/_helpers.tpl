{{/*
@file fw-app Helm helpers（T-M8-07 / PRD-008 FR-09）
@description 命名与标签模板函数集合；渲染器需支持 include / default / trunc / trimSuffix / contains / printf / replace / quote / nindent / toYaml 等内置函数。
@author donttemo
@created 2026-10-14
*/}}

{{/* 基础名：优先 nameOverride，否则 chart 名 */}}
{{- define "fw-app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* 全名：优先 fullnameOverride，否则 release 名 + chart 名（去重） */}}
{{- define "fw-app.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "fw-app.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* 通用标签（Helm 官方推荐集） */}}
{{- define "fw-app.labels" -}}
helm.sh/chart: {{ include "fw-app.chart" . }}
{{ include "fw-app.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: fw
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
{{- end -}}

{{- define "fw-app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "fw-app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "fw-app.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "fw-app.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* 镜像引用：tag 缺省回退 Chart.appVersion */}}
{{- define "fw-app.image" -}}
{{- $tag := default .Chart.AppVersion .Values.image.tag -}}
{{- printf "%s:%s" .Values.image.repository $tag -}}
{{- end -}}

{{- define "fw-app.configuredSecretName" -}}
{{- if .Values.secrets.existingSecret -}}
{{- .Values.secrets.existingSecret -}}
{{- else -}}
{{- printf "%s-secrets" (include "fw-app.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/* ConfigMap 数据：values.config 全量 + configInValues 时的非敏感连接串，供 ConfigMap 与 checksum 复用 */}}
{{- define "fw-app.configData" -}}
{{- range $k, $v := .Values.config }}
{{ $k }}: {{ $v | quote }}
{{- end }}
{{- if .Values.configInValues }}
{{- range $k, $v := .Values.configUrls }}
{{- if $v }}
{{ $k }}: {{ $v | quote }}
{{- end }}
{{- end }}
{{- end }}
{{- end -}}
