import { Actor } from 'apify';
import { CheerioCrawler, log } from 'crawlee';

await Actor.init();

try {
    const input = await Actor.getInput();
    const { startUrls, crawlLinks = false, maxPages } = input;

    if (!startUrls || startUrls.length === 0) {
        throw new Error('startUrls is required!');
    }

    log.info(`Starting Schema Markup Extractor with ${startUrls.length} URL(s). crawlLinks=${crawlLinks}`);

    // PPE: Base charge for starting
    await Actor.charge({ eventName: 'apify-actor-start', count: 1 });

    let extractedCount = 0;

    const crawler = new CheerioCrawler({
        maxRequestsPerCrawl: maxPages || 1000,
        async requestHandler({ request, $, enqueueLinks, log }) {

            // If crawlLinks enabled, enqueue internal links
            if (crawlLinks) {
                await enqueueLinks({ strategy: 'same-domain' });
            }

            // Extract all JSON-LD <script> blocks
            const jsonLdScripts = $('script[type="application/ld+json"]').toArray();

            if (jsonLdScripts.length === 0) {
                log.info(`No JSON-LD found on: ${request.url}`);
                return;
            }

            const schemas = [];
            for (const el of jsonLdScripts) {
                try {
                    const content = $(el).html();
                    if (!content) continue;

                    const parsed = JSON.parse(content);

                    // Flatten @graph arrays and individual objects
                    const items = parsed['@graph']
                        ? parsed['@graph']
                        : Array.isArray(parsed)
                            ? parsed
                            : [parsed];

                    for (const item of items) {
                        const types = Array.isArray(item['@type'])
                            ? item['@type']
                            : item['@type']
                                ? [item['@type']]
                                : ['Unknown'];

                        schemas.push({
                            '@type': types,
                            raw_json: item
                        });
                    }
                } catch (e) {
                    // Skip malformed JSON-LD blocks
                }
            }

            if (schemas.length === 0) return;

            // Flatten all detected types for quick scanning
            const allTypes = [...new Set(schemas.flatMap(s => s['@type']))];

            const record = {
                url: request.url,
                scrapedAt: new Date().toISOString(),
                schema_count: schemas.length,
                schema_types_found: allTypes,
                has_faq: allTypes.some(t => t === 'FAQPage'),
                has_review: allTypes.some(t => ['Review', 'AggregateRating'].includes(t)),
                has_product: allTypes.some(t => t === 'Product'),
                has_article: allTypes.some(t => ['Article', 'BlogPosting', 'NewsArticle'].includes(t)),
                has_breadcrumb: allTypes.some(t => t === 'BreadcrumbList'),
                schemas
            };

            await Actor.pushData(record);
            await Actor.charge({ eventName: 'page-extracted', count: 1 });

            extractedCount++;
            log.info(`📋 Extracted ${schemas.length} schema(s) from: ${request.url} [Types: ${allTypes.join(', ')}]`);

            if (maxPages && extractedCount >= maxPages) {
                log.info('Reached maxPages limit, stopping.');
                await crawler.teardown();
            }
        },
        async failedRequestHandler({ request, log }) {
            log.error(`Request ${request.url} failed too many times.`);
        },
    });

    const initialRequests = startUrls.map(req => ({
        url: typeof req === 'string' ? req : req.url
    }));

    await crawler.addRequests(initialRequests);
    await crawler.run();

    log.info(`🎉 Done! Extracted schema from ${extractedCount} pages.`);
} catch (error) {
    console.error('CRASH:', error);
    throw error;
} finally {
    await Actor.exit();
}
