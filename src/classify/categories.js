'use strict';

// Categorias exibidas no painel. `alert` marca o que deve chamar a atenção
// da mãe; `hidden` marca o tráfego de fundo que o celular gera sozinho.
const CATEGORIES = {
  adulto: { label: 'Conteúdo adulto / Pornografia', alert: true },
  apostas: { label: 'Apostas e Cassino (Tigrinho, Bets)', alert: true },
  perigoso: { label: 'Arriscado (violência, namoro, chat anônimo)', alert: true },
  redes_sociais: { label: 'Redes sociais' },
  video: { label: 'Vídeos e streaming' },
  jogos: { label: 'Jogos' },
  mensagens: { label: 'Mensagens e chat' },
  ia: { label: 'Assistentes de IA' },
  infantil: { label: 'Infantil e Desenhos' },
  educacao: { label: 'Educação e Escola' },
  busca: { label: 'Busca' },
  compras: { label: 'Compras' },
  outros: { label: 'Outros sites' },
  desconhecido: { label: 'Ainda não classificado' },
  anuncios: { label: 'Anúncios e rastreamento', hidden: true },
  sistema: { label: 'Sistema do celular', hidden: true },
};

// Domínios conhecidos (domínio registrável -> categoria).
const KNOWN = {
  adulto: [
    'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'tube8.com',
    'spankbang.com', 'eporner.com', 'brazzers.com', 'onlyfans.com', 'fansly.com', 'privacy.com.br',
    'chaturbate.com', 'stripchat.com', 'bongacams.com', 'cam4.com', 'livejasmin.com', 'nhentai.net',
    'e-hentai.org', 'hentaihaven.xxx', 'rule34.xxx', 'phncdn.com', 'xvideos-cdn.com', 'xnxx-cdn.com',
    'camsoda.com', 'beeg.com', 'porn.com', 'hentaihaven.me', 'rule34.paheal.net', 'gelbooru.com',
    'danbooru.donmai.us', 'tnaflix.com', 'heavy-r.com', 'fetlife.com', 'erome.com', 'coomeet.com',
  ],
  apostas: [
    'bet365.com', 'betano.com', 'sportingbet.com', 'estrelabet.com', 'pixbet.com', 'blaze.com', 'betnacional.com',
    'superbet.com', 'novibet.com', 'kto.com', 'vaidebet.com', 'esportesdasorte.com', 'betfair.com', 'stake.com',
    'galera.bet', 'f12.bet', 'pokerstars.com', 'loterias.caixa.gov.br', 'brazino777.com', '777.com',
    'mcgames.bet', 'jonbet.com', 'jogodotigre.net', 'fortune-tiger.com', 'h2bet.net', 'segurobet.com',
    'betfair.com.br', 'apostaganha.bet', 'realsbet.com', 'luva.bet', 'betboom.com', 'parimatch.com',
    'onabet.com', 'cassino.org', 'cassino.com.br', 'betsson.com', 'betway.com',
  ],
  perigoso: [
    'ome.tv', 'chatroulette.com', 'omegle.com', 'monkey.app', 'yubo.live', 'wizz.chat', 'tinder.com', 'badoo.com',
    'bumble.com', 'hinge.co', 'grindr.com', 'tellonym.me', 'ngl.link', 'sendit.app', 'azar.live',
    'bestgore.fun', 'seelen.com', 'kaotic.com', 'goregrish.com', 'theync.com', 'crazyshit.com', 'livegore.com',
    'watchpeopledie.tv', '4chan.org', '4channel.org', 'chathub.cam', 'emeraldchat.com', 'strangerchat.net',
    'camloo.com', 'bazoocam.org', 'happn.com', 'jaumo.com', 'badoo.net',
  ],
  redes_sociais: [
    'tiktok.com', 'tiktokv.com', 'tiktokcdn.com', 'tiktokcdn-us.com', 'byteoversea.com', 'ibytedtos.com', 'musical.ly',
    'instagram.com', 'cdninstagram.com', 'facebook.com', 'fbcdn.net', 'fb.com', 'threads.net', 'snapchat.com',
    'sc-cdn.net', 'snapkit.com', 'twitter.com', 'x.com', 'twimg.com', 'kwai.com', 'kwai.net', 'kwaicdn.com',
    'pinterest.com', 'pinimg.com', 'reddit.com', 'redd.it', 'redditmedia.com', 'tumblr.com', 'likee.video',
    'bsky.app', 'lemon8-app.com', 'threads.com', 'weibo.com', 'vk.com',
  ],
  video: [
    'youtube.com', 'youtu.be', 'googlevideo.com', 'ytimg.com', 'youtube-nocookie.com', 'netflix.com', 'nflxvideo.net',
    'nflximg.net', 'nflxso.net', 'primevideo.com', 'aiv-cdn.net', 'disneyplus.com', 'disney-plus.net', 'bamgrid.com',
    'max.com', 'hbomax.com', 'globoplay.globo.com', 'twitch.tv', 'ttvnw.net', 'vimeo.com', 'dailymotion.com',
    'crunchyroll.com', 'pluto.tv', 'spotify.com', 'scdn.co', 'deezer.com', 'paramountplus.com', 'apple.tv',
  ],
  jogos: [
    'roblox.com', 'rbxcdn.com', 'rbx.com', 'robloxlabs.com', 'minecraft.net', 'mojang.com', 'minecraftservices.com',
    'epicgames.com', 'fortnite.com', 'unrealengine.com', 'supercell.com', 'garena.com', 'freefiremobile.com',
    'playstation.com', 'playstation.net', 'xbox.com', 'xboxlive.com', 'nintendo.com', 'nintendo.net',
    'steampowered.com', 'steamcommunity.com', 'poki.com', 'friv.com', 'miniclip.com', 'crazygames.com', 'itch.io',
    'kiloo.com', 'sybo.com', 'outfit7.com', 'kitkagames.com', 'scopely.com', 'pokemon.com', 'nianticlabs.com',
    'gameloft.com', 'zynga.com', 'king.com', 'rovio.com', 'moonactive.net', 'playrix.com', 'habbo.com',
    'avakin.com', 'pkgames.com', 'jogos360.com.br', 'clickjogos.com.br', 'stumbleguys.com', 'playpkxd.com',
    'afterverse.com', 'gartic.com.br', 'gartic.io', 'brawlstars.com', 'clashroyale.com', 'clashofclans.com',
    'subwaysurfers.com', 'zakezh.com', 'friv5online.com', 'kizi.com', 'y8.com', '1001jogos.com.br',
  ],
  mensagens: [
    'whatsapp.com', 'whatsapp.net', 'telegram.org', 't.me', 'discord.com', 'discord.gg', 'discordapp.com',
    'discordapp.net', 'signal.org', 'messenger.com', 'kik.com', 'skype.com',
  ],
  ia: [
    'openai.com', 'chatgpt.com', 'oaistatic.com', 'character.ai', 'claude.ai', 'anthropic.com', 'perplexity.ai',
    'gemini.google.com', 'copilot.microsoft.com', 'replika.com', 'talkie-ai.com', 'chai-research.com',
  ],
  infantil: [
    'youtubekids.com', 'pbskids.org', 'nickjr.com', 'lego.com', 'tocaboca.com', 'sesamestreet.org',
    'turmadamonica.com.br', 'cartoonnetwork.com', 'discoverykidsplus.com', 'babybus.com', 'lunetas.com.br',
    'playkids.com', 'galinhapintadinha.com.br', 'disney.com.br', 'disneyjunior.com', 'peppapig.com',
  ],
  educacao: [
    'khanacademy.org', 'kastatic.org', 'duolingo.com', 'wikipedia.org', 'wikimedia.org', 'escolagames.com.br',
    'smartkids.com.br', 'brainpop.com', 'mit.edu', 'code.org', 'classroom.google.com', 'brainly.com.br',
    'toddle.com', 'scielo.org', 'geogebra.org', 'scratch.mit.edu',
  ],
  busca: ['google.com', 'google.com.br', 'bing.com', 'duckduckgo.com', 'yahoo.com', 'ecosia.org', 'brave.com'],
  compras: [
    'amazon.com', 'amazon.com.br', 'mercadolivre.com.br', 'mercadolibre.com', 'mlstatic.com', 'shopee.com.br',
    'shopee.com', 'shein.com', 'aliexpress.com', 'temu.com', 'magazineluiza.com.br', 'magalu.com',
  ],
  anuncios: [
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'google-analytics.com', 'googletagmanager.com',
    'app-measurement.com', 'admob.com', 'applovin.com', 'applvn.com', 'unityads.unity3d.com', 'appsflyer.com',
    'appsflyersdk.com', 'adjust.com', 'branch.io', 'ironsrc.com', 'ironsrc.mobi', 'vungle.com', 'chartboost.com',
    'inmobi.com', 'mopub.com', 'moloco.com', 'liftoff.io', 'pangle.io', 'pangleglobal.com', 'adcolony.com',
    'fyber.com', 'mintegral.com', 'rayjump.com', 'criteo.com', 'taboola.com', 'outbrain.com', 'scorecardresearch.com',
    'crashlytics.com', 'onesignal.com', 'amplitude.com', 'mixpanel.com', 'facebook.net', 'segment.io',
    // Redes de leilão de anúncios (RTB) — comuns em sites e jogos "grátis":
    'amazon-adsystem.com', 'rubiconproject.com', 'pubmatic.com', 'openx.net', 'adnxs.com', 'media.net',
    'smartadserver.com', 'id5-sync.com', 'onetag-sys.com', 'servenobid.com', 'a-mo.net', 'optidigital.com',
    'lijit.com', 'bidswitch.net', 'sharethrough.com', '1rx.io', 'simpli.fi', 'adform.net', 'adsrvr.org',
    'bidr.io', 'connatix.com', 'primis.tech', 'doubleverify.com', 'unrulymedia.com', 'appier.net', 'rlcdn.com',
    'creativecdn.com', 'casalemedia.com', 'yieldmo.com', 'teads.tv', '3lift.com', 'gumgum.com', 'indexww.com',
    'adsafeprotected.com', 'moatads.com', 'quantserve.com', 'bluekai.com', 'rfihub.com', 'demdex.net',
    'everesttech.net', 'adroll.com', 'smaato.net', 'pubnative.net', 'startappservice.com', 'supersonicads.com',
    'tapjoy.com', 'digitalturbine.com', 'adtng.com', 'smartnews-ads.com', 'yieldlab.net', 'adingo.jp',
    'contextweb.com', 'gammaplatform.com', 'districtm.io', 'crwdcntrl.net', 'eyeota.net', 'agkn.com',
    'mfadsr.com', 'mobfox.com', 'yllix.com', 'propellerads.com', 'popads.net', 'popcash.net', 'adsterra.com',
    'exoclick.com', 'juicyads.com', 'trafficjunky.net', 'ad-maven.com', 'hilltopads.net', 'clickadu.com',
  ],
  sistema: [
    'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'gvt1.com', 'gvt2.com', 'android.com', 'googlezip.net',
    'firebaseio.com', 'firebase.com', 'firebaseinstallations.googleapis.com', 'google.internal', 'withgoogle.com',
    'apple.com', 'icloud.com', 'icloud-content.com', 'mzstatic.com', 'apple-dns.net', 'aaplimg.com', 'cdn-apple.com',
    'samsung.com', 'samsungcloud.com', 'samsungapps.com', 'samsungosp.com', 'samsungqbe.com', 'xiaomi.com',
    'xiaomi.net', 'miui.com', 'mi.com', 'motorola.com', 'lenovo.com', 'huawei.com', 'hicloud.com', 'dbankcloud.com',
    'microsoft.com', 'msftconnecttest.com', 'windowsupdate.com', 'live.com', 'office.com', 'akamai.net',
    'akamaiedge.net', 'akamaihd.net', 'akamaized.net', 'edgekey.net', 'cloudflare.com', 'cloudflare-dns.com',
    'cloudfront.net', 'amazonaws.com', 'fastly.net', 'fastly-edge.com', 'edgecastcdn.net', 'azureedge.net',
    'jsdelivr.net', 'unity3d.com', 'ntp.org', 'pool.ntp.org', 'digicert.com', 'letsencrypt.org', 'sentry.io',
    'qualcomm.com', 'gcp.gvt2.com', 'dns.google',
  ],
};

// Sufixos (TLDs) que já denunciam a categoria.
const TLD_RULES = [
  { suffix: 'xxx', category: 'adulto' },
  { suffix: 'porn', category: 'adulto' },
  { suffix: 'adult', category: 'adulto' },
  { suffix: 'sex', category: 'adulto' },
  { suffix: 'cam', category: 'adulto' },
  { suffix: 'bet.br', category: 'apostas' },
  { suffix: 'bet', category: 'apostas' },
  { suffix: 'casino', category: 'apostas' },
  { suffix: 'poker', category: 'apostas' },
];

// Palavras no nome do domínio.
const KEYWORD_RULES = [
  { re: /porn|xvideo|xnxx|hentai|nsfw|onlyfans|camgirl|putaria|sexo|sexy|xxx|nudes|redtube|spankbang|brazzers|erotic|camsoda|beeg|tnaflix|heavy-r|fetlife|erome/i, category: 'adulto' },
  { re: /cassino|casino|aposta|tigrinho|roleta|bet365|betano|blaze|fortune.?tiger|slot|jackpot|bacara|poker|sportingbet|estrelabet|pixbet|betnacional|superbet|novibet|vaidebet|esportesdasorte|onabet|parimatch|brazino/i, category: 'apostas' },
  { re: /bestgore|seelen|kaotic|goregrish|theync|crazyshit|livegore|watchpeopledie|deathaddict|omegle|chatroulette|strangerchat|chathub|emeraldchat/i, category: 'perigoso' },
];

module.exports = { CATEGORIES, KNOWN, TLD_RULES, KEYWORD_RULES };
