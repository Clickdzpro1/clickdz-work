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
    behavior_flags: None,
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
    raw_model_id: "claude-3-7-sonnet-20250219".to_string(),
    display_name: Some("Claude 3.7 Sonnet".to_string()),
    aliases: vec!["claude-3-7-sonnet".to_string(), "claude-3-7-sonnet-20250219".to_string()],
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
    raw_model_id: "claude-3-5-sonnet-20241022".to_string(),
    display_name: Some("Claude 3.5 Sonnet".to_string()),
    aliases: vec!["claude-3-5-sonnet".to_string(), "claude-3-5-sonnet-20241022".to_string()],
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
    behavior_flags: None,
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-3-5-haiku".to_string(),
    raw_model_id: "claude-3-5-haiku-20241022".to_string(),
    display_name: Some("Claude 3.5 Haiku".to_string()),
    aliases: vec!["claude-3-5-haiku".to_string(), "claude-3-5-haiku-20241022".to_string()],
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
    behavior_flags: None,
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-3-opus".to_string(),
    raw_model_id: "claude-3-opus-20240229".to_string(),
    display_name: Some("Claude 3 Opus".to_string()),
    aliases: vec!["claude-3-opus".to_string(), "claude-3-opus-20240229".to_string()],
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
    behavior_flags: None,
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "anthropic".to_string(),
    canonical_key: "claude-3-haiku".to_string(),
    raw_model_id: "claude-3-haiku-20240307".to_string(),
    display_name: Some("Claude 3 Haiku".to_string()),
    aliases: vec!["claude-3-haiku".to_string(), "claude-3-haiku-20240307".to_string()],
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
    behavior_flags: None,
  });

  // OpenAI backend variants
  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.5".to_string(),
    raw_model_id: "gpt-5.5".to_string(),
    display_name: Some("GPT 5.5".to_string()),
    aliases: vec!["gpt-5.5".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: Some(image_attachment.clone()),
      default_for_output_type: None,
    }],
    protocol: Some("openai_responses".to_string()),
    request_layer: Some("responses".to_string()),
    route_overrides: None,
    behavior_flags: None,
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.4".to_string(),
    raw_model_id: "gpt-5.4".to_string(),
    display_name: Some("GPT 5.4".to_string()),
    aliases: vec!["gpt-5.4".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: Some(image_attachment.clone()),
      default_for_output_type: None,
    }],
    protocol: Some("openai_responses".to_string()),
    request_layer: Some("responses".to_string()),
    route_overrides: None,
    behavior_flags: None,
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.4-mini".to_string(),
    raw_model_id: "gpt-5.4-mini".to_string(),
    display_name: Some("GPT 5.4 Mini".to_string()),
    aliases: vec!["gpt-5.4-mini".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: Some(image_attachment.clone()),
      default_for_output_type: None,
    }],
    protocol: Some("openai_responses".to_string()),
    request_layer: Some("responses".to_string()),
    route_overrides: None,
    behavior_flags: None,
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.4-nano".to_string(),
    raw_model_id: "gpt-5.4-nano".to_string(),
    display_name: Some("GPT 5.4 Nano".to_string()),
    aliases: vec!["gpt-5.4-nano".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: Some(image_attachment.clone()),
      default_for_output_type: None,
    }],
    protocol: Some("openai_responses".to_string()),
    request_layer: Some("responses".to_string()),
    route_overrides: None,
    behavior_flags: None,
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.3".to_string(),
    raw_model_id: "gpt-5.3".to_string(),
    display_name: Some("GPT 5.3".to_string()),
    aliases: vec!["gpt-5.3".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: Some(image_attachment.clone()),
      default_for_output_type: None,
    }],
    protocol: Some("openai_responses".to_string()),
    request_layer: Some("responses".to_string()),
    route_overrides: None,
    behavior_flags: None,
  });

  variants.push(llm_adapter::core::ModelRegistryVariant {
    backend_kind: "openai_responses".to_string(),
    canonical_key: "gpt-5.1".to_string(),
    raw_model_id: "gpt-5.1".to_string(),
    display_name: Some("GPT 5.1".to_string()),
    aliases: vec!["gpt-5.1".to_string()],
    legacy_aliases: None,
    capabilities: vec![llm_adapter::core::ModelCapability {
      input: vec!["text".to_string(), "image".to_string()],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(image_attachment.clone()),
      structured_attachments: Some(image_attachment.clone()),
      default_for_output_type: None,
    }],
    protocol: Some("openai_responses".to_string()),
    request_layer: Some("responses".to_string()),
    route_overrides: None,
    behavior_flags: None,
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
      input: vec![
        "text".to_string(),
        "image".to_string(),
        "audio".to_string(),
        "file".to_string(),
      ],
      output: vec!["text".to_string(), "object".to_string(), "structured".to_string()],
      attachments: Some(gemini_attachment.clone()),
      structured_attachments: Some(gemini_attachment.clone()),
      default_for_output_type: None,
    }],
    protocol: Some("gemini".to_string()),
    request_layer: Some("gemini_api".to_string()),
    route_overrides: None,
    behavior_flags: Some(vec![
      "prefetch_remote_attachments".to_string(),
      "structured_retry".to_string(),
      "reasoning_medium".to_string(),
    ]),
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
      attachment_source_kinds: None,
      has_remote_attachments: None,
      model_id: None,
      output_type: Some("embedding".to_string()),
    };
    let response = llm_match_model_registry(ModelRegistryMatchRequest {
      backend_kind: "gemini_api".to_string(),
      cond,
    })
    .unwrap();

    assert_eq!(response.variant.unwrap().raw_model_id, "gemini-embedding-001");
  }

  #[test]
  fn should_resolve_gemini_embedding_2() {
    let response = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: Some("gemini_api".to_string()),
      model_id: "gemini-embedding-2".to_string(),
    })
    .unwrap();
    let variant = response.variant.unwrap();

    assert_eq!(variant.raw_model_id, "gemini-embedding-2");
    assert_eq!(variant.protocol.as_deref(), Some("gemini"));
    assert_eq!(variant.request_layer.as_deref(), Some("gemini_api"));
    assert_eq!(variant.display_name.as_deref(), Some("Gemini Embedding 2"));
  }

  #[test]
  fn should_keep_same_raw_id_as_two_backend_variants() {
    let api_variant = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: Some("gemini_api".to_string()),
      model_id: "gemini-2.5-flash".to_string(),
    })
    .unwrap()
    .variant
    .unwrap();
    let vertex_variant = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: Some("gemini_vertex".to_string()),
      model_id: "gemini-2.5-flash".to_string(),
    })
    .unwrap()
    .variant
    .unwrap();

    assert_eq!(api_variant.raw_model_id, vertex_variant.raw_model_id);
    assert_ne!(api_variant.backend_kind, vertex_variant.backend_kind);
  }

  #[test]
  fn should_route_image_models_to_image_protocols() {
    let openai = llm_match_model_registry(ModelRegistryMatchRequest {
      backend_kind: "openai_responses".to_string(),
      cond: ModelConditionsContract {
        input_types: Some(vec!["text".to_string()]),
        attachment_kinds: None,
        attachment_source_kinds: None,
        has_remote_attachments: None,
        model_id: Some("gpt-image-1".to_string()),
        output_type: Some("image".to_string()),
      },
    })
    .unwrap()
    .variant
    .unwrap();
    assert_eq!(openai.protocol.as_deref(), Some("openai_images"));
    assert_eq!(openai.request_layer.as_deref(), Some("openai_images"));

    let fal = llm_match_model_registry(ModelRegistryMatchRequest {
      backend_kind: "fal".to_string(),
      cond: ModelConditionsContract {
        input_types: Some(vec!["text".to_string()]),
        attachment_kinds: None,
        attachment_source_kinds: None,
        has_remote_attachments: None,
        model_id: Some("flux-1/schnell".to_string()),
        output_type: Some("image".to_string()),
      },
    })
    .unwrap()
    .variant
    .unwrap();
    assert_eq!(fal.protocol.as_deref(), Some("fal_image"));
    assert_eq!(fal.request_layer.as_deref(), Some("fal"));

    let gemini = llm_match_model_registry(ModelRegistryMatchRequest {
      backend_kind: "gemini_api".to_string(),
      cond: ModelConditionsContract {
        input_types: Some(vec!["text".to_string()]),
        attachment_kinds: None,
        attachment_source_kinds: None,
        has_remote_attachments: None,
        model_id: Some("gemini-2.5-flash-image".to_string()),
        output_type: Some("image".to_string()),
      },
    })
    .unwrap()
    .variant
    .unwrap();
    assert_eq!(gemini.protocol.as_deref(), Some("gemini"));
    assert_eq!(gemini.request_layer.as_deref(), Some("gemini_api"));

    let generic_gemini_image = llm_match_model_registry(ModelRegistryMatchRequest {
      backend_kind: "gemini_api".to_string(),
      cond: ModelConditionsContract {
        input_types: Some(vec!["text".to_string()]),
        attachment_kinds: None,
        attachment_source_kinds: None,
        has_remote_attachments: None,
        model_id: Some("gemini-2.5-flash".to_string()),
        output_type: Some("image".to_string()),
      },
    })
    .unwrap();
    assert!(generic_gemini_image.variant.is_none());
  }

  #[test]
  fn should_resolve_custom_claude_opus_48() {
    let response = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: Some("anthropic".to_string()),
      model_id: "claude-opus-4-8".to_string(),
    })
    .unwrap();
    let variant = response.variant.unwrap();
    assert_eq!(variant.raw_model_id, "claude-opus-4-8");
    assert_eq!(variant.backend_kind, "anthropic");
    assert_eq!(variant.display_name.as_deref(), Some("Claude Opus 4.8"));
  }

  #[test]
  fn should_resolve_custom_gpt_55() {
    let response = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: Some("openai_responses".to_string()),
      model_id: "gpt-5.5".to_string(),
    })
    .unwrap();
    let variant = response.variant.unwrap();
    assert_eq!(variant.raw_model_id, "gpt-5.5");
    assert_eq!(variant.backend_kind, "openai_responses");
    assert_eq!(variant.display_name.as_deref(), Some("GPT 5.5"));
  }

  #[test]
  fn should_resolve_custom_gemini_3_flash_preview() {
    let response = llm_resolve_model_registry_variant(ModelRegistryResolveRequest {
      backend_kind: Some("gemini_api".to_string()),
      model_id: "gemini-3-flash-preview".to_string(),
    })
    .unwrap();
    let variant = response.variant.unwrap();
    assert_eq!(variant.raw_model_id, "gemini-3-flash-preview");
    assert_eq!(variant.backend_kind, "gemini_api");
    assert_eq!(variant.display_name.as_deref(), Some("Gemini 3 Flash Preview"));
  }
}
