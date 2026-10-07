export function createMetadata(
  seopath: any,
  entity?: any,
  dataWithLocale?: any[],
) {
  let path: Record<string, string> = {};
  if (dataWithLocale) {
    dataWithLocale.forEach((item) => {
      path = {
        ...path,
        [item.locale]: `${entity ? item.entity_slug + "/" : ""}${item.slug}`,
      };
    });
  }
  const entity_field_title =
    entity && entity.languages && entity.languages?.length > 0
      ? entity.languages.find(
          (lang: any) =>
            lang.slug === seopath.entity_slug && lang.locale === seopath.locale,
        )?.slug
      : seopath.title;

  const entity_title =
    entity && entity.languages && entity.languages?.length > 0
      ? entity.languages.find(
          (lang: any) =>
            lang.slug === seopath.entity_slug && lang.locale === seopath.locale,
        )?.title
      : entity?.title;

  if (entity) {
    return {
      slug: `${seopath.entity_slug}/${seopath.slug}`,
      entity_slug: seopath.entity_slug,
      entity: `${seopath.entity_save_data}`,
      entity_field: seopath.entity_slug,
      entity_title,
      entity_field_id: `${entity.collection_name}`,
      entity_field_title: entity_title ?? entity_field_title,
      type: seopath.redirect_url ? "redirect" : "direct",
      redirect_to: seopath.redirect_url
        ? `${entity ? seopath.entity_slug + "/" : ""}${seopath.redirect_url}`
        : null,
      path,
    };
  }
  return {
    slug: `${seopath.slug}`,
    entity_slug: seopath.entity_slug,
    entity: `${seopath.entity_save_data}`,
    entity_field_title,
    entity_title: entity?.title,
    entity_field: seopath.entity_slug,
    type: seopath.redirect_url ? "redirect" : "direct",
    redirect_to: seopath.redirect_url
      ? `${entity ? seopath.entity_slug + "/" : ""}${seopath.redirect_url}`
      : null,
    path,
  };
}
