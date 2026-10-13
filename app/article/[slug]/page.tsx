import { runtimeUrls } from '@/lib/runtime-config';
import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { getArticleBySlug } from "@/lib/strapi";
import { renderSafeMarkdown } from "@/lib/safe-markdown";
import ArticleMedia from "@/components/ArticleMedia";
import ImageSlider from "@/components/ImageSlider";
import { notFound } from "next/navigation";
import styles from "./page.module.css";

interface ArticlePageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata(
  { params }: ArticlePageProps
): Promise<Metadata> {
  const { slug } = await params;
  const strapiUrl = runtimeUrls().publicStrapi || "http://localhost:1337";

  let article = null;
  try {
    article = await getArticleBySlug(slug);
  } catch {
    // ignore
  }

  if (!article) {
    return { title: "Article introuvable \u2014 GTHDF" };
  }

  const seo = article.seo;
  const title = seo?.metaTitle || article.title;
  const description = seo?.metaDescription || article.excerpt || article.description;
  const imageUrl = seo?.shareImage?.url
    ? toAbsoluteMediaUrl(seo.shareImage.url, strapiUrl)
    : toAbsoluteMediaUrl(article.cover?.url, strapiUrl);

  return {
    title: `${title} \u2014 GTHDF`,
    description,
    openGraph: {
      title,
      description,
      type: "article",
      publishedTime: article.publishedAt,
      ...(imageUrl && { images: [{ url: imageUrl }] }),
    },
    twitter: {
      card: "summary_large_image",
    },
  };
}

function toAbsoluteMediaUrl(url: string | undefined, strapiUrl: string) {
  if (!url) return null;
  return url.startsWith("http") ? url : `${strapiUrl}${url}`;
}

export default async function ArticlePage({ params }: ArticlePageProps) {
  const { slug } = await params;

  const article = await getArticleBySlug(slug);

  if (!article) {
    notFound();
  }

  const strapiUrl = runtimeUrls().publicStrapi || 'http://localhost:1337';

  return (
    <div className={styles.page}>
      <main className={styles.container}>
        <article>
          {article.category && (
            <span className={styles.category}>{article.category.name}</span>
          )}

          <h1 className={styles.title}>{article.title}</h1>

          {article.description && (
            <p className={styles.description}>{article.description}</p>
          )}

          {article.author && (
            <div className={styles.authorBlock}>
              {toAbsoluteMediaUrl(article.author.avatar?.url, strapiUrl) && (
                <Image
                  src={toAbsoluteMediaUrl(article.author.avatar?.url, strapiUrl) || ""}
                  alt={article.author.name}
                  width={56}
                  height={56}
                  className={styles.authorAvatar}
                />
              )}
              <div>
                {article.author.slug ? (
                  <Link href={`/auteur/${article.author.slug}`} className={styles.authorName}>
                    {article.author.name}
                  </Link>
                ) : (
                  <div className={styles.authorName}>{article.author.name}</div>
                )}
                {article.author.email && (
                  <div className={styles.authorEmail}>{article.author.email}</div>
                )}
              </div>
            </div>
          )}

          <div className={styles.content}>
            {article.blocks?.map((block, index) => {
              switch (block.__component) {
                case 'shared.rich-text':
                  return (
                    <div
                      key={index}
                      className={styles.richText}
                      dangerouslySetInnerHTML={{ __html: renderSafeMarkdown(block.body || '') }}
                    />
                  );

                case 'shared.media':
                  return block.file?.url ? (
                    <ArticleMedia
                      key={index}
                      src={toAbsoluteMediaUrl(block.file.url, strapiUrl) || ""}
                      alt={block.file.alternativeText || block.file.name || ''}
                      caption={block.file.caption || undefined}
                      width={block.file.width}
                      height={block.file.height}
                    />
                  ) : null;

                case 'shared.quote':
                  return (
                    <blockquote key={index} className={styles.quote}>
                      <p className={styles.quoteText}>{block.body}</p>
                      {block.title && (
                        <cite className={styles.quoteAuthor}>— {block.title}</cite>
                      )}
                    </blockquote>
                  );

                case 'shared.slider': {
                  const files = block.files || [];

                  return files.length > 0 ? (
                    <ImageSlider
                      key={index}
                      images={files
                        .map((file) => ({
                          url: toAbsoluteMediaUrl(file.url, strapiUrl) || "",
                          alternativeText: file.alternativeText || undefined,
                        }))
                        .filter((img: { url: string }) => img.url)
                      }
                    />
                  ) : null;
                }

                default:
                  return null;
              }
            })}
          </div>
        </article>
      </main>
    </div>
  );
}
