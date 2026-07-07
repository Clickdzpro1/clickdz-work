use napi::Result;

use crate::llm::core::contracts::{
  ModelRegistryMatchRequest, ModelRegistryMatchResponse, ModelRegistryResolveRequest, ModelRegistryResolveResponse,
  ModelRegistryVariantContract,
};

fn to_contract_variant(variant: &llm_adapter::core::ModelRegistryVariant) -> Result<ModelRegistryVariantContract> {
  serde_json::to_value(variant)
    .and_then(serde_json::from_value)
    .map_err(crate::llm::map_json_error)
}

fn custom_model_registry_variants() -> Vec<llm_adapter::core::ModelRegistryVariant> {
  let image_attachment = llm_adapter::core::CapabilityAttachment {
    kinds: vec!["image".to_string()],
    source_kinds: Some(vec!["url".to_string(), "data".to_string()]),
    allow_remote_urls: Some(true),
  };

  let gemini_attachment = llm_adapter::core::CapabilityAttachment {
    kinds: vec!["image".to_string(), "audio".to_string(), "file".to_string()],
    source_kinds: Some(vec![
      "url".to_string(),
      "data".to_string(),
      "bytes".to_string(),
      "file_handle".to_string(),
    ]),
    allow_remote_urls: Some(true),
  };

  let mut variants = Vec::new();

  // Anthropic backend variants
  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-opus-4-8".to_string(),
    raw_model_id: "claude-opus-4-8".to_string(),
    display_name: Some("Claude Opus 4.8".to_string()),
    aliases: vec!["claude-opus-4-8".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("anthropic".to_string()),
    request_layer: Some("anthropic".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_12000".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-opus-4-7".to_string(),
    raw_model_id: "claude-opus-4-7".to_string(),
    display_name: Some("Claude Opus 4.7".to_string()),
    aliases: vec!["claude-opus-4-7".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("anthropic".to_string()),
    request_layer: Some("anthropic".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_12000".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-opus-4-6".to_string(),
    raw_model_id: "claude-opus-4-6".to_string(),
    display_name: Some("Claude Opus 4.6".to_string()),
    aliases: vec!["claude-opus-4-6".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("anthropic".to_string()),
    request_layer: Some("anthropic".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_12000".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-haiku-4-5".to_string(),
    raw_model_id: "claude-haiku-4-5".to_string(),
    display_name: Some("Claude Haiku 4.5".to_string()),
    aliases: vec!["claude-haiku-4-5".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("anthropic".to_string()),
    request_layer: Some("anthropic".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_12000".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-opus-4-5".to_string(),
    raw_model_id: "claude-opus-4-5".to_string(),
    display_name: Some("Claude Opus 4.5".to_string()),
    aliases: vec!["claude-opus-4-5".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("anthropic".to_string()),
    request_layer: Some("anthropic".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_12000".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-opus-4-1".to_string(),
    raw_model_id: "claude-opus-4-1".to_string(),
    display_name: Some("Claude Opus 4.1".to_string()),
    aliases: vec!["claude-opus-4-1".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("anthropic".to_string()),
    request_layer: Some("anthropic".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_12000".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-3-7-sonnet".to_string(),
    raw_model_id: "claude-3-7-sonnet".to_string(),
    display_name: Some("Claude 3.7 Sonnet".to_string()),
    aliases: vec!["claude-3-7-sonnet".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("anthropic".to_string()),
    request_layer: Some("anthropic".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_12000".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-3-5-sonnet".to_string(),
    raw_model_id: "claude-3-5-sonnet".to_string(),
    display_name: Some("Claude 3.5 Sonnet".to_string()),
    aliases: vec!["claude-3-5-sonnet".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("anthropic".to_string()),
    request_layer: Some("anthropic".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_12000".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-3-5-haiku".to_string(),
    raw_model_id: "claude-3-5-haiku".to_string(),
    display_name: Some("Claude 3.5 Haiku".to_string()),
    aliases: vec!["claude-3-5-haiku".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("anthropic".to_string()),
    request_layer: Some("anthropic".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_12000".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-3-opus".to_string(),
    raw_model_id: "claude-3-opus".to_string(),
    display_name: Some("Claude 3 Opus".to_string()),
    aliases: vec!["claude-3-opus".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("anthropic".to_string()),
    request_layer: Some("anthropic".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_12000".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-3-haiku".to_string(),
    raw_model_id: "claude-3-haiku".to_string(),
    display_name: Some("Claude 3 Haiku".to_string()),
    aliases: vec!["claude-3-haiku".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("anthropic".to_string()),
    request_layer: Some("anthropic".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_12000".to_string()]),
  });

  // OpenAI backend variants (openai_responses)
  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.5".to_string(),
    raw_model_id: "gpt-5.5".to_string(),
    display_name: Some("GPT-5.5".to_string()),
    aliases: vec!["gpt-5.5".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("openai".to_string()),
    request_layer: Some("openai".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_32000".to_string(), "function_calling".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.4".to_string(),
    raw_model_id: "gpt-5.4".to_string(),
    display_name: Some("GPT-5.4".to_string()),
    aliases: vec!["gpt-5.4".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("openai".to_string()),
    request_layer: Some("openai".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_32000".to_string(), "function_calling".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.4-mini".to_string(),
    raw_model_id: "gpt-5.4-mini".to_string(),
    display_name: Some("GPT-5.4 Mini".to_string()),
    aliases: vec!["gpt-5.4-mini".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("openai".to_string()),
    request_layer: Some("openai".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_32000".to_string(), "function_calling".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.4-nano".to_string(),
    raw_model_id: "gpt-5.4-nano".to_string(),
    display_name: Some("GPT-5.4 Nano".to_string()),
    aliases: vec!["gpt-5.4-nano".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("openai".to_string()),
    request_layer: Some("openai".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_32000".to_string(), "function_calling".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.3".to_string(),
    raw_model_id: "gpt-5.3".to_string(),
    display_name: Some("GPT-5.3".to_string()),
    aliases: vec!["gpt-5.3".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("openai".to_string()),
    request_layer: Some("openai".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_32000".to_string(), "function_calling".to_string()]),
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.1".to_string(),
    raw_model_id: "gpt-5.1".to_string(),
    display_name: Some("GPT-5.1".to_string()),
    aliases: vec!["gpt-5.1".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("openai".to_string()),
    request_layer: Some("openai".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec!["reasoning_budget_32000".to_string(), "function_calling".to_string()]),
  });

  // Gemini backend variants
  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "gemini_api".to_string(),
    canonical_key: "gemini-3-flash-preview".to_string(),
    raw_model_id: "gemini-3-flash-preview".to_string(),
    display_name: Some("Gemini 3 Flash Preview".to_string()),
    aliases: vec!["gemini-3-flash-preview".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string(), "audio".to_string()],
      output: vec!["text".to_string(), "object".to_string()],
      attachments: Some(gemini_attachment.clone()),
      structured_attachments: None,
      default_for_output_type: None,
    }],
    protocol: Some("gemini".to_string()),
    request_layer: Some("gemini".to_string()),
    route_overrides: None,
    behavior_flags: None,
  });

  variants
}

fn all_model_registry_variants() -> Vec<llm_adapter::core::ModelRegistryVariant> {
  let mut variants = llm_adapter::core::default_model_registry_variants();
  variants.extend(custom_model_registry_variants());
  variants
}

#[napi(catch_unwind)]
pub fn llm_resolve_model_registry_variant(
  request: ModelRegistryResolveRequest,
) -> Result<ModelRegistryResolveResponse> {
  let variants = all_model_registry_variants();
  let response = match llm_adapter::core::resolve_model_registry_variant(
    &variants,
    request.backend_kind.as_deref(),
    request.model_id.as_str(),
  )
  .map_err(crate::llm::host::invalid_arg)?
  {
    Some((variant, matched_by)) => ModelRegistryResolveResponse {
      variant: Some(to_contract_variant(variant)?),
      matched_by: Some(matched_by.to_string()),
    },
    None => ModelRegistryResolveResponse {
      variant: None,
      matched_by: None,
    },
  };

  Ok(response)
}

#[napi(catch_unwind)]
pub fn llm_match_model_registry(request: ModelRegistryMatchRequest) -> Result<ModelRegistryMatchResponse> {
  let variants = all_model_registry_variants();
  let cond = serde_json::to_value(request.cond)
    .and_then(serde_json::from_value)
    .map_err(crate::llm::map_json_error)?;
  let response = ModelRegistryMatchResponse {
    variant: llm_adapter::core::select_model_registry_variant(&variants, request.backend_kind.as_str(), &cond)
      .map_err(crate::llm::host::invalid_arg)?
      .map(to_contract_variant)
      .transpose()?,
  };

  Ok(response)
}

#[cfg(test)]
mod tests {
  use super::{llm_match_model_registry, llm_resolve_model_registry_variant};
  use crate::llm::core::contracts::{ModelConditionsContract, ModelRegistryMatchRequest, ModelRegistryResolveRequest};

  #[test]
  fn should_resolve_backend_scoped_alias() {
    let response = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: Some("anthropic_vertex".to_string()),
      model_id: "claude-sonnet-4.6".to_string(),
    })
    .unwrap();

    assert_eq!(response.matched_by.as_deref(), Some("canonical"));
    assert_eq!(response.variant.unwrap().raw_model_id, "claude-sonnet-4-6");
  }

  #[test]
  fn should_reject_ambiguous_alias_without_backend() {
    let error = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: None,
      model_id: "claude-sonnet-4.5".to_string(),
    })
    .unwrap_err();

    assert!(error.to_string().contains("Ambiguous canonical"));
  }

  #[test]
  fn should_resolve_legacy_alias() {
    let response = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: Some("openai_responses".to_string()),
      model_id: "gpt-5-2025-08-07".to_string(),
    })
    .unwrap();

    assert_eq!(response.matched_by.as_deref(), Some("legacy_alias"));
    assert_eq!(response.variant.unwrap().raw_model_id, "gpt-5");
  }

  #[test]
  fn should_match_default_variant_by_backend_and_output() {
    let cond = ModelConditionsContract {
      input_types: Some(vec!["text".to_string()]),
      attachment_kinds: None,
      output_type: None,
    };
    let response = llm_match_model_registry(ModelRegistryMatchRequest {
      backend_kind: "openai_responses".to_string(),
      cond,
    })
    .unwrap();

    let variant = response.variant.unwrap();
    assert_eq!(variant.raw_model_id, "gpt-5-nano");
    assert_eq!(variant.backend_kind, "openai_responses");
  }

  #[test]
  fn should_resolve_claude_opus_48() {
    let response = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: Some("anthropic".to_string()),
      model_id: "claude-opus-4-8".to_string(),
    })
    .unwrap();

    assert_eq!(response.matched_by.as_deref(), Some("canonical"));
    assert_eq!(response.variant.unwrap().raw_model_id, "claude-opus-4-8");
  }

  #[test]
  fn should_resolve_gpt_55() {
    let response = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: Some("openai_responses".to_string()),
      model_id: "gpt-5.5".to_string(),
    })
    .unwrap();

    assert_eq!(response.matched_by.as_deref(), Some("canonical"));
    assert_eq!(response.variant.unwrap().raw_model_id, "gpt-5.5");
  }

  #[test]
  fn should_resolve_gemini_3_flash_preview() {
    let response = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: Some("gemini_api".to_string()),
      model_id: "gemini-3-flash-preview".to_string(),
    })
    .unwrap();

    assert_eq!(response.matched_by.as_deref(), Some("canonical"));
    assert_eq!(response.variant.unwrap().raw_model_id, "gemini-3-flash-preview");
  }
}
