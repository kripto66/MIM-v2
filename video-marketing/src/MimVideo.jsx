import React, {useMemo} from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';

const colors = {
  bg0: '#08030f',
  bg1: '#12081f',
  bg2: '#1d0b2e',
  panel: 'rgba(255,255,255,0.055)',
  panelStrong: 'rgba(255,255,255,0.09)',
  line: 'rgba(255,255,255,0.11)',
  text: '#f3eefc',
  soft: '#c9bfe0',
  dim: '#998bb8',
  violet: '#8b5cf6',
  violet2: '#7c3aed',
  magenta: '#d946ef',
  gold: '#e5a017',
  gold2: '#f0b429',
  green: '#34d399',
  red: '#fb7185',
  blue: '#60a5fa',
};

const scenes = [
  {id: 'intro', start: 0, duration: 150, clip: '01-probleme', caption: 'Vos biens, vos locataires et vos échéances sont dispersés ?'},
  {id: 'solution', start: 150, duration: 210, clip: '02-solution', caption: 'Découvrez MyImmoManagement, la plateforme qui simplifie la gestion de votre patrimoine locatif.'},
  {id: 'dashboard', start: 360, duration: 300, clip: '03-dashboard', caption: 'Depuis un tableau de bord clair, suivez vos logements, vos occupants, vos échéances et vos incidents.'},
  {id: 'biens', start: 660, duration: 270, clip: '04-biens', caption: 'Ajoutez vos biens, rattachez les logements et réorganisez votre parc en quelques clics.'},
  {id: 'paiements', start: 930, duration: 270, clip: '05-paiements', caption: 'Pour les règlements, le locataire déclare son paiement. Vous le vérifiez, puis vous le validez.'},
  {id: 'maintenance', start: 1200, duration: 210, clip: '06-maintenance', caption: 'Un incident signalé devient une intervention planifiée, suivie et clôturée.'},
  {id: 'equipe', start: 1410, duration: 150, clip: '07-equipe', caption: 'Importez vos données et donnez à votre équipe les accès adaptés à son rôle.'},
  {id: 'cta', start: 1560, duration: 240, clip: '08-cta', caption: 'Une gestion plus simple, plus claire, plus maîtrisée. Commencez dès aujourd’hui avec MyImmoManagement.'},
];

const iconPaths = {
  building: <><path d="M4 21V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v17"/><path d="M16 9h3a1 1 0 0 1 1 1v11"/><path d="M2 21h20"/><path d="M8 7h3M8 11h3M8 15h3M8 19h3"/></>,
  home: <><path d="m3 10 9-7 9 7"/><path d="M5 9v11h14V9"/><path d="M9 20v-6h6v6"/></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/></>,
  card: <><rect x="2" y="4" width="20" height="16" rx="2"/><path d="M2 10h20M6 15h4"/></>,
  alert: <><path d="m10.3 3.8-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3.2l-8-14a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></>,
  tools: <><path d="m14.7 6.3 3 3M4 20l8.5-8.5M13 3a5 5 0 0 0 5.9 6.9L21 12l-3 3-2.1-2.1A5 5 0 0 0 9 4l2 2Z"/><path d="m5 19 3 3"/></>,
  bell: <><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/></>,
  settings: <><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-1.8 1.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5v.2h-2.5v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1-1.8-1.8.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H4v-2.5h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1 1.8-1.8.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.5V5h2.5v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1 1.8 1.8-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.5 1h.2v2.5h-.2a1.7 1.7 0 0 0-1.5 1Z"/></>,
  check: <path d="m5 12 4 4L19 6"/>,
  arrow: <><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></>,
  upload: <><path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v4h16v-4"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  plus: <><path d="M12 5v14M5 12h14"/></>,
  chart: <><path d="M4 19V5M4 19h16"/><path d="m7 15 3-4 3 2 4-6"/></>,
};

const Icon = ({name, size = 18, color = colors.text, strokeWidth = 1.8}) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
    {iconPaths[name] || iconPaths.home}
  </svg>
);

const HouseMark = ({size = 42, radius = 12}) => (
  <div style={{width: size, height: size, borderRadius: radius, display: 'grid', placeItems: 'center', background: `linear-gradient(135deg, ${colors.violet}, ${colors.magenta})`, color: '#fff', boxShadow: `0 10px 28px ${colors.violet}66`}}>
    <svg width={size * 0.5} height={size * 0.5} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 9.5 9-5.5 9 5.5"/><path d="M5 11v8h14v-8"/><path d="M9.5 19v-5h5v5"/>
    </svg>
  </div>
);

const Brand = ({scale = 1, light = false}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: 11 * scale, fontSize: 19 * scale, fontWeight: 600, letterSpacing: -0.3 * scale, color: light ? colors.text : colors.text}}>
    <HouseMark size={40 * scale} radius={11 * scale}/>
    <span>MyImmo<span style={{color: colors.gold}}>Management</span></span>
  </div>
);

const Background = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const time = frame / fps;
  const particles = useMemo(() => Array.from({length: 26}, (_, index) => ({
    x: (index * 37 + 11) % 100,
    y: (index * 61 + 7) % 100,
    size: 1 + (index % 4) * 0.7,
    phase: index * 0.71,
    opacity: 0.12 + (index % 5) * 0.035,
  })), []);
  return (
    <AbsoluteFill style={{background: `radial-gradient(circle at 78% 8%, ${colors.violet}25, transparent 34%), radial-gradient(circle at 8% 92%, ${colors.magenta}18, transparent 36%), linear-gradient(145deg, ${colors.bg0}, ${colors.bg1} 54%, ${colors.bg2})`, overflow: 'hidden'}}>
      <AbsoluteFill style={{opacity: 0.12, backgroundImage: `linear-gradient(${colors.line} 1px, transparent 1px), linear-gradient(90deg, ${colors.line} 1px, transparent 1px)`, backgroundSize: '64px 64px', maskImage: 'linear-gradient(to bottom, black, transparent 78%)'}}/>
      {particles.map((particle, index) => (
        <div key={index} style={{position: 'absolute', left: `${particle.x}%`, top: `${(particle.y + Math.sin(time * 0.18 + particle.phase) * 1.8 + 100) % 100}%`, width: particle.size, height: particle.size, borderRadius: 99, background: index % 3 === 0 ? colors.gold2 : colors.violet, opacity: particle.opacity, boxShadow: `0 0 ${12 + particle.size * 4}px currentColor`}}/>
      ))}
      <div style={{position: 'absolute', width: 460, height: 460, borderRadius: '50%', border: `1px solid ${colors.violet}26`, right: '-210px', top: '42%', transform: `rotate(${time * 2}deg)`}}/>
      <div style={{position: 'absolute', width: 300, height: 300, borderRadius: '50%', border: `1px solid ${colors.gold}1c`, left: '-160px', bottom: '14%', transform: `rotate(${-time * 1.4}deg)`}}/>
    </AbsoluteFill>
  );
};

const Chrome = ({vertical}) => {
  const frame = useCurrentFrame();
  const {durationInFrames} = useVideoConfig();
  const progress = Math.min(1, frame / durationInFrames);
  const top = vertical ? 42 : 34;
  const side = vertical ? 56 : 72;
  return (
    <>
      <div style={{position: 'absolute', top, left: side, zIndex: 20, opacity: 0.92}}>
        <Brand scale={vertical ? 0.72 : 0.78}/>
      </div>
      <div style={{position: 'absolute', top: top + 9, right: side, zIndex: 20, color: colors.dim, fontSize: vertical ? 12 : 13, letterSpacing: 2, textTransform: 'uppercase'}}>MIM · gestion locative</div>
      <div style={{position: 'absolute', left: side, right: side, bottom: vertical ? 28 : 30, height: 3, borderRadius: 99, background: 'rgba(255,255,255,0.1)', zIndex: 20, overflow: 'hidden'}}>
        <div style={{height: '100%', width: `${progress * 100}%`, background: `linear-gradient(90deg, ${colors.violet}, ${colors.magenta}, ${colors.gold2})`, boxShadow: `0 0 16px ${colors.gold2}`}}/>
      </div>
    </>
  );
};

const Kicker = ({children, vertical = false}) => (
  <div style={{display: 'inline-flex', alignItems: 'center', gap: 9, color: colors.gold2, fontSize: vertical ? 13 : 14, fontWeight: 800, letterSpacing: 2.1, textTransform: 'uppercase'}}>
    <span style={{width: 26, height: 2, background: colors.gold2, borderRadius: 99}}/>
    {children}
  </div>
);

const Headline = ({children, vertical = false, fontSize}) => (
  <div style={{fontSize: fontSize || (vertical ? 58 : 64), lineHeight: 1.04, letterSpacing: -2.2, fontWeight: 800, color: colors.text, maxWidth: vertical ? 860 : 720}}>{children}</div>
);

const Body = ({children, vertical = false}) => (
  <div style={{fontSize: vertical ? 23 : 22, lineHeight: 1.42, color: colors.soft, maxWidth: vertical ? 820 : 630}}>{children}</div>
);

const Pill = ({children, color = colors.violet, vertical = false}) => (
  <div style={{display: 'inline-flex', alignItems: 'center', gap: 9, borderRadius: 99, padding: vertical ? '11px 17px' : '10px 15px', background: `${color}18`, border: `1px solid ${color}55`, color: color === colors.gold2 ? colors.gold2 : colors.text, fontSize: vertical ? 15 : 14, fontWeight: 700}}>
    <span style={{width: 8, height: 8, borderRadius: 99, background: color, boxShadow: `0 0 14px ${color}`}}/>
    {children}
  </div>
);

const Caption = ({text, duration, vertical}) => {
  const frame = useCurrentFrame();
  const opacity = interpolate(frame, [0, 4, Math.max(4, duration - 12), duration], [0.65, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  return (
    <div style={{position: 'absolute', left: vertical ? 56 : 72, right: vertical ? 56 : 72, bottom: vertical ? 60 : 62, display: 'flex', justifyContent: 'center', zIndex: 25, pointerEvents: 'none', opacity}}>
      <div style={{maxWidth: vertical ? 880 : 980, padding: vertical ? '10px 17px' : '9px 18px', borderRadius: 12, background: 'rgba(8,3,15,0.78)', border: '1px solid rgba(255,255,255,0.12)', color: colors.text, fontSize: vertical ? 17 : 16, lineHeight: 1.35, textAlign: 'center', backdropFilter: 'blur(12px)'}}>{text}</div>
    </div>
  );
};

const SceneFade = ({children, duration, vertical}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const opacity = interpolate(frame, [0, 4, Math.max(4, duration - 10), duration], [0.65, 1, 1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'});
  const lift = spring({frame, fps, config: {stiffness: 75, damping: 18}});
  return <AbsoluteFill style={{opacity, transform: `translateY(${(1 - lift) * 16}px)`}}>{children}</AbsoluteFill>;
};

const SceneLayout = ({children, vertical}) => (
  <AbsoluteFill style={{display: 'flex', flexDirection: vertical ? 'column' : 'row', alignItems: 'center', justifyContent: 'center', gap: vertical ? 34 : 86, padding: vertical ? '150px 56px 130px' : '170px 120px 140px'}}>{children}</AbsoluteFill>
);

const TextBlock = ({children, vertical, width}) => (
  <div style={{width: width || (vertical ? '100%' : '43%'), minWidth: 0, display: 'flex', flexDirection: 'column', gap: vertical ? 24 : 28, alignItems: 'flex-start'}}>{children}</div>
);

const Window = ({children, vertical, title = 'app.mim-app.com/dashboard'}) => {
  const scale = vertical ? 0.88 : 1;
  return (
    <div style={{width: vertical ? '100%' : '53%', maxWidth: vertical ? 860 : 990, height: vertical ? 720 : 610, borderRadius: vertical ? 22 : 18, overflow: 'hidden', background: 'rgba(16,7,29,0.96)', border: `1px solid ${colors.lineStrong || colors.line}`, boxShadow: `0 34px 90px rgba(0,0,0,0.52), 0 0 0 1px ${colors.violet}12`, flexShrink: 0}}>
      <div style={{height: vertical ? 38 : 34, display: 'flex', alignItems: 'center', gap: 7, padding: '0 15px', borderBottom: `1px solid ${colors.line}`, background: 'rgba(255,255,255,0.035)'}}>
        <span style={{width: 8, height: 8, borderRadius: 99, background: '#fb7185'}}/><span style={{width: 8, height: 8, borderRadius: 99, background: colors.gold2}}/><span style={{width: 8, height: 8, borderRadius: 99, background: colors.green}}/>
        <span style={{marginLeft: 7, color: colors.dim, fontSize: 10 * scale, letterSpacing: 0.3}}>{title}</span>
      </div>
      <div style={{height: vertical ? 'calc(100% - 38px)' : 'calc(100% - 34px)', padding: vertical ? 15 : 18, boxSizing: 'border-box', fontSize: 12 * scale, color: colors.text}}>{children}</div>
    </div>
  );
};

const Panel = ({children, style}) => <div style={{background: colors.panel, border: `1px solid ${colors.line}`, borderRadius: 12, padding: 14, boxSizing: 'border-box', ...style}}>{children}</div>;

const NavItem = ({icon, label, active = false, compact = false}) => (
  <div style={{display: 'flex', alignItems: 'center', gap: compact ? 7 : 10, padding: compact ? '8px 9px' : '10px 12px', borderRadius: 9, color: active ? colors.text : colors.dim, background: active ? `${colors.violet}36` : 'transparent', fontSize: compact ? 10 : 11, fontWeight: active ? 700 : 600}}>
    <Icon name={icon} size={compact ? 14 : 16} color={active ? colors.gold2 : colors.dim}/>
    {label}
  </div>
);

const DashboardContent = ({vertical}) => {
  const compact = vertical;
  return (
    <div style={{display: 'flex', height: '100%', gap: compact ? 12 : 16}}>
      <div style={{width: compact ? 142 : 170, flexShrink: 0, padding: compact ? 10 : 13, borderRadius: 10, background: 'linear-gradient(165deg, rgba(124,58,237,0.25), rgba(29,11,46,0.8))', border: `1px solid ${colors.line}`}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 7, marginBottom: 19, fontSize: compact ? 13 : 15, fontWeight: 800}}><HouseMark size={compact ? 25 : 30} radius={7}/> MIM</div>
        <NavItem icon="chart" label="Tableau de bord" active compact={compact}/>
        <NavItem icon="building" label="Mes biens" compact={compact}/>
        <NavItem icon="home" label="Logements" compact={compact}/>
        <NavItem icon="users" label="Locataires" compact={compact}/>
        <NavItem icon="card" label="Paiements" compact={compact}/>
        <NavItem icon="alert" label="Incidents" compact={compact}/>
        <NavItem icon="tools" label="Interventions" compact={compact}/>
        <NavItem icon="bell" label="Notifications" compact={compact}/>
      </div>
      <div style={{flex: 1, minWidth: 0}}>
        <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: compact ? 13 : 17}}>
          <div><div style={{fontSize: compact ? 19 : 23, fontWeight: 800}}>Bonjour, Propriétaire</div><div style={{color: colors.dim, marginTop: 2}}>Voici un aperçu de votre activité.</div></div>
          <div style={{display: 'flex', alignItems: 'center', gap: 8, color: colors.soft, fontSize: compact ? 10 : 11}}><span style={{width: 24, height: 24, display: 'grid', placeItems: 'center', borderRadius: 99, background: colors.violet, color: '#fff'}}>P</span> Mon profil</div>
        </div>
        <div style={{display: 'grid', gridTemplateColumns: compact ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: compact ? 9 : 12, marginBottom: compact ? 10 : 14}}>
          {[['Logements', '24', colors.violet], ['Occupés', '18', colors.green], ['Loyers attendus', '1 275 000', colors.gold2], ['À valider', '3', colors.magenta]].map(([label, value, color]) => (
            <Panel key={label} style={{padding: compact ? 10 : 13}}><div style={{fontSize: compact ? 9 : 10, color: colors.dim}}>{label}</div><div style={{fontSize: compact ? 19 : 23, fontWeight: 800, color, marginTop: 4, whiteSpace: 'nowrap'}}>{value}</div><div style={{fontSize: compact ? 8 : 9, color: colors.dim, marginTop: 2}}>{label === 'Occupés' ? '75% du parc' : label === 'À valider' ? 'déclarations' : 'mise à jour'}</div></Panel>
          ))}
        </div>
        <div style={{display: 'grid', gridTemplateColumns: '1.1fr 0.9fr', gap: compact ? 9 : 12}}>
          <Panel style={{padding: compact ? 10 : 13}}><div style={{display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginBottom: 8}}>Paiements récents <span style={{color: colors.violet, fontSize: 9}}>Voir tout</span></div>{[['Appartement A1', '450 000 F', colors.green], ['Studio B3', '350 000 F', colors.green], ['Chambre C1', '250 000 F', colors.gold2]].map(([name, amount, color]) => <div key={name} style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: compact ? '7px 0' : '9px 0', borderTop: `1px solid ${colors.line}`, fontSize: compact ? 9 : 10}}><span style={{color: colors.soft}}>{name}</span><span style={{color, fontWeight: 700}}>{amount}</span></div>)}</Panel>
          <Panel style={{padding: compact ? 10 : 13}}><div style={{display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginBottom: 8}}>Incidents actifs <span style={{color: colors.violet, fontSize: 9}}>Voir tout</span></div>{[['Fuite d’eau', 'Urgent', colors.red], ['Prise électrique', 'En attente', colors.gold2], ['Climatisation', 'En cours', colors.blue]].map(([name, state, color]) => <div key={name} style={{display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: compact ? '7px 0' : '9px 0', borderTop: `1px solid ${colors.line}`, fontSize: compact ? 9 : 10}}><span style={{color: colors.soft}}>{name}</span><span style={{color, fontWeight: 700}}>{state}</span></div>)}</Panel>
        </div>
      </div>
    </div>
  );
};

const PropertyContent = () => (
  <div style={{display: 'flex', flexDirection: 'column', height: '100%', gap: 13}}>
    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}><div><div style={{fontSize: 20, fontWeight: 800}}>Mes biens</div><div style={{color: colors.dim, marginTop: 2}}>Votre parc immobilier</div></div><div style={{display: 'flex', alignItems: 'center', gap: 7, borderRadius: 9, padding: '9px 12px', background: colors.gold2, color: '#211300', fontSize: 11, fontWeight: 800}}><Icon name="plus" size={14} color="#211300"/> Ajouter un bien</div></div>
    <div style={{display: 'grid', gridTemplateColumns: '1.15fr 0.85fr', gap: 12, minHeight: 0, flex: 1}}>
      <Panel style={{padding: 12}}><div style={{display: 'flex', justifyContent: 'space-between', fontWeight: 700, marginBottom: 8}}>Vos immeubles <span style={{color: colors.dim, fontSize: 10}}>3 actifs</span></div>{[['Résidence Les Palmiers', '12 logements', '92% occupé', colors.green], ['Immeuble Keur Massar', '8 logements', '75% occupé', colors.gold2], ['Villa Almadies', '4 logements', '100% occupé', colors.green]].map(([name, units, status, color], index) => <div key={name} style={{display: 'flex', alignItems: 'center', gap: 10, padding: index === 0 ? 11 : '13px 0', borderTop: index === 0 ? 'none' : `1px solid ${colors.line}`}}><div style={{width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 9, background: `${colors.violet}22`, color: colors.violet}}><Icon name="building" size={18}/></div><div style={{flex: 1, minWidth: 0}}><div style={{fontSize: 11, fontWeight: 700}}>{name}</div><div style={{color: colors.dim, fontSize: 9, marginTop: 2}}>{units}</div></div><div style={{color, fontSize: 9, fontWeight: 700, whiteSpace: 'nowrap'}}>{status}</div></div>)}</Panel>
      <Panel style={{padding: 12, background: `linear-gradient(145deg, ${colors.violet}22, rgba(255,255,255,0.03))`}}><div style={{color: colors.gold2, fontSize: 10, fontWeight: 800, letterSpacing: 1}}>VOTRE PARC</div><div style={{fontSize: 30, fontWeight: 800, marginTop: 7}}>24</div><div style={{color: colors.soft, fontSize: 11}}>logements suivis</div><div style={{height: 7, borderRadius: 99, background: 'rgba(255,255,255,0.1)', marginTop: 18, overflow: 'hidden'}}><div style={{height: '100%', width: '75%', background: `linear-gradient(90deg, ${colors.violet}, ${colors.magenta})`}}/></div><div style={{display: 'flex', justifyContent: 'space-between', color: colors.dim, fontSize: 9, marginTop: 7}}><span>18 occupés</span><span>6 libres</span></div><div style={{display: 'flex', alignItems: 'center', gap: 7, marginTop: 24, color: colors.soft, fontSize: 10}}><Icon name="users" size={14} color={colors.gold2}/> 18 locataires</div></Panel>
    </div>
  </div>
);

const PaymentContent = () => (
  <div style={{display: 'flex', flexDirection: 'column', height: '100%', gap: 14}}>
    <div><div style={{fontSize: 20, fontWeight: 800}}>Suivi des règlements</div><div style={{color: colors.dim, marginTop: 2}}>Déclaration, vérification et validation</div></div>
    <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, flex: 1, alignItems: 'center'}}>
      <Panel style={{padding: 14, borderColor: `${colors.violet}55`}}><div style={{width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 10, background: `${colors.violet}22`, color: colors.violet}}><Icon name="users" size={18}/></div><div style={{fontWeight: 800, marginTop: 15}}>Locataire</div><div style={{color: colors.soft, fontSize: 10, lineHeight: 1.4, marginTop: 5}}>Déclare son règlement après paiement.</div><div style={{display: 'inline-flex', marginTop: 13, padding: '5px 8px', borderRadius: 99, background: `${colors.gold2}1c`, color: colors.gold2, fontSize: 9, fontWeight: 800}}>Déclaration envoyée</div></Panel>
      <div style={{display: 'flex', alignItems: 'center', justifyContent: 'center', color: colors.violet}}><Icon name="arrow" size={24}/></div>
      <Panel style={{padding: 14, borderColor: `${colors.gold2}66`}}><div style={{width: 34, height: 34, display: 'grid', placeItems: 'center', borderRadius: 10, background: `${colors.gold2}22`, color: colors.gold2}}><Icon name="card" size={18}/></div><div style={{fontWeight: 800, marginTop: 15}}>Propriétaire</div><div style={{color: colors.soft, fontSize: 10, lineHeight: 1.4, marginTop: 5}}>Vérifie la déclaration et confirme.</div><div style={{display: 'inline-flex', marginTop: 13, padding: '5px 8px', borderRadius: 99, background: `${colors.green}1c`, color: colors.green, fontSize: 9, fontWeight: 800}}>Validation</div></Panel>
    </div>
    <div style={{display: 'flex', alignItems: 'center', gap: 9, padding: 11, borderRadius: 10, background: 'rgba(52,211,153,0.08)', border: `1px solid ${colors.green}28`, color: colors.soft, fontSize: 10}}><Icon name="check" size={16} color={colors.green}/><span><strong style={{color: colors.text}}>Historique clair</strong> · chaque déclaration reste traçable</span></div>
  </div>
);

const MaintenanceContent = () => (
  <div style={{display: 'flex', flexDirection: 'column', height: '100%', gap: 14}}>
    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}><div><div style={{fontSize: 20, fontWeight: 800}}>Incident · Fuite d’eau</div><div style={{color: colors.dim, marginTop: 2}}>Appartement A1 · Résidence Les Palmiers</div></div><div style={{padding: '7px 10px', borderRadius: 99, background: `${colors.red}1c`, color: colors.red, fontSize: 9, fontWeight: 800}}>Urgent</div></div>
    <div style={{display: 'grid', gridTemplateColumns: '0.9fr 1.1fr', gap: 12, flex: 1}}>
      <Panel style={{padding: 14, background: `linear-gradient(145deg, ${colors.violet}20, rgba(255,255,255,0.03))`}}><div style={{color: colors.dim, fontSize: 9, fontWeight: 800, letterSpacing: 1}}>SIGNALEMENT</div><div style={{fontSize: 25, fontWeight: 800, marginTop: 10, lineHeight: 1.1}}>Une fuite sous l’évier nécessite une intervention.</div><div style={{display: 'flex', alignItems: 'center', gap: 8, color: colors.soft, fontSize: 10, marginTop: 20}}><Icon name="clock" size={15} color={colors.gold2}/> Signalé aujourd’hui à 09:42</div><div style={{display: 'flex', alignItems: 'center', gap: 8, color: colors.soft, fontSize: 10, marginTop: 9}}><Icon name="tools" size={15} color={colors.violet}/> Prestataire assigné</div></Panel>
      <Panel style={{padding: 14}}><div style={{fontWeight: 800, marginBottom: 12}}>Suivi de l’intervention</div>{[['Signalé', 'Aujourd’hui · 09:42', colors.green], ['Planifié', 'Demain · 10:00', colors.gold2], ['En cours', 'À venir', colors.dim], ['Résolu', '—', colors.dim]].map(([label, date, color], index) => <div key={label} style={{display: 'flex', gap: 10, minHeight: 49}}><div style={{display: 'flex', flexDirection: 'column', alignItems: 'center'}}><div style={{width: 20, height: 20, display: 'grid', placeItems: 'center', borderRadius: 99, background: index === 0 ? `${color}30` : 'rgba(255,255,255,0.07)', color, border: `1px solid ${color}66`}}>{index === 0 ? <Icon name="check" size={12} color={color}/> : <span style={{width: 5, height: 5, borderRadius: 99, background: color}}/>}</div>{index < 3 && <div style={{width: 1, flex: 1, background: colors.line}}/>}</div><div style={{paddingBottom: 12}}><div style={{fontSize: 11, fontWeight: 800, color: index === 0 ? colors.text : colors.soft}}>{label}</div><div style={{fontSize: 9, color: colors.dim, marginTop: 3}}>{date}</div></div></div>)}</Panel>
    </div>
  </div>
);

const TeamContent = () => (
  <div style={{display: 'flex', flexDirection: 'column', height: '100%', gap: 14}}>
    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}><div><div style={{fontSize: 20, fontWeight: 800}}>Votre équipe</div><div style={{color: colors.dim, marginTop: 2}}>Un espace pour chaque rôle</div></div><div style={{display: 'flex', alignItems: 'center', gap: 6, color: colors.gold2, fontSize: 10, fontWeight: 800}}><Icon name="upload" size={15}/> Importer</div></div>
    <div style={{display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10, flex: 1}}>
      {[['Propriétaire', 'Pilotage complet', colors.gold2, 'building'], ['Employé', 'Tâches et interventions', colors.violet, 'tools'], ['Prestataire', 'Interventions assignées', colors.magenta, 'users']].map(([role, detail, color, icon]) => <Panel key={role} style={{padding: 14, borderColor: `${color}38`}}><div style={{width: 38, height: 38, display: 'grid', placeItems: 'center', borderRadius: 11, background: `${color}22`, color}}><Icon name={icon} size={20}/></div><div style={{fontWeight: 800, marginTop: 17}}>{role}</div><div style={{color: colors.soft, fontSize: 10, lineHeight: 1.4, marginTop: 5}}>{detail}</div><div style={{display: 'flex', alignItems: 'center', gap: 6, color, fontSize: 9, fontWeight: 800, marginTop: 18}}><span style={{width: 6, height: 6, borderRadius: 99, background: color}}/> Accès adapté</div></Panel>)}
    </div>
    <Panel style={{padding: 12, display: 'flex', alignItems: 'center', gap: 10, background: `${colors.gold2}0d`, borderColor: `${colors.gold2}28`}}><div style={{color: colors.gold2}}><Icon name="upload" size={18}/></div><div style={{flex: 1}}><div style={{fontSize: 11, fontWeight: 800}}>Import CSV</div><div style={{color: colors.soft, fontSize: 9, marginTop: 2}}>Reprenez vos données existantes sans ressaisie.</div></div><Icon name="arrow" size={17} color={colors.gold2}/></Panel>
  </div>
);

const IntroVisual = ({vertical}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const pulse = 1 + Math.sin(frame / fps * 2) * 0.025;
  return (
    <div style={{width: vertical ? '100%' : '50%', height: vertical ? 650 : 650, position: 'relative', display: 'grid', placeItems: 'center'}}>
      <div style={{position: 'absolute', inset: vertical ? '28px 0' : '20px 15px', borderRadius: 28, overflow: 'hidden', border: `1px solid ${colors.lineStrong || colors.line}`, boxShadow: `0 35px 100px rgba(0,0,0,0.46)`}}>
        <Img src={staticFile('salon.webp')} style={{width: '100%', height: '100%', objectFit: 'cover', filter: 'saturate(0.72) contrast(1.04)', opacity: 0.3}}/>
        <div style={{position: 'absolute', inset: 0, background: `linear-gradient(145deg, ${colors.bg0}22, ${colors.bg2}e8 82%)`}}/>
        <div style={{position: 'absolute', inset: 0, padding: 26, display: 'flex', flexDirection: 'column', justifyContent: 'space-between'}}>
          <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}><div style={{fontSize: 11, color: colors.soft, letterSpacing: 1.4}}>VOTRE PATRIMOINE</div><div style={{color: colors.gold2, fontSize: 10, fontWeight: 800}}>MIM</div></div>
          <div><div style={{fontSize: vertical ? 31 : 37, lineHeight: 1.05, fontWeight: 800, maxWidth: 350}}>Tout commence par une <span style={{color: colors.gold2}}>vue claire.</span></div><div style={{display: 'flex', gap: 7, marginTop: 18}}><Pill color={colors.violet}>Biens</Pill><Pill color={colors.gold2}>Locataires</Pill><Pill color={colors.magenta}>Suivi</Pill></div></div>
        </div>
      </div>
      <div style={{position: 'absolute', top: vertical ? 0 : 32, right: vertical ? -4 : -2, transform: `scale(${pulse})`, padding: '12px 15px', borderRadius: 13, background: 'rgba(18,8,31,0.88)', border: `1px solid ${colors.gold2}55`, boxShadow: `0 15px 30px ${colors.gold2}22`}}><div style={{color: colors.gold2, fontSize: 9, fontWeight: 800}}>À VOIR</div><div style={{fontSize: 11, fontWeight: 700, marginTop: 3}}>Vos rents en un coup d’œil</div></div>
      <div style={{position: 'absolute', bottom: vertical ? 3 : -38, left: vertical ? -4 : -12, padding: '12px 15px', borderRadius: 13, background: 'rgba(18,8,31,0.9)', border: `1px solid ${colors.violet}66`, boxShadow: `0 15px 30px ${colors.violet}22`}}><div style={{color: colors.violet, fontSize: 9, fontWeight: 800}}>UNE SEULE PLATEFORME</div><div style={{fontSize: 11, fontWeight: 700, marginTop: 3}}>Moins de saisies. Plus de contrôle.</div></div>
    </div>
  );
};

const SolutionVisual = ({vertical}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const rotation = frame / fps * 2.5;
  return (
    <div style={{width: vertical ? '100%' : '50%', height: 610, position: 'relative', display: 'grid', placeItems: 'center'}}>
      <div style={{width: vertical ? 480 : 520, height: vertical ? 480 : 520, borderRadius: '50%', border: `1px solid ${colors.violet}35`, transform: `rotate(${rotation}deg)`, position: 'absolute', boxShadow: `inset 0 0 80px ${colors.violet}12, 0 0 80px ${colors.violet}12`}}/>
      <div style={{width: vertical ? 370 : 400, height: vertical ? 370 : 400, borderRadius: '50%', border: `1px solid ${colors.gold2}35`, transform: `rotate(${-rotation * 1.7}deg)`, position: 'absolute'}}/>
      <div style={{position: 'relative', width: 235, height: 235, borderRadius: 30, display: 'grid', placeItems: 'center', textAlign: 'center', background: `linear-gradient(145deg, ${colors.violet}44, ${colors.bg2}ee)`, border: `1px solid ${colors.violet}88`, boxShadow: `0 0 70px ${colors.violet}44`}}><HouseMark size={62} radius={18}/><div style={{fontSize: 16, fontWeight: 800, marginTop: 13}}>MIM</div><div style={{color: colors.soft, fontSize: 10, marginTop: 2}}>MyImmoManagement</div></div>
      <div style={{position: 'absolute', top: 60, right: vertical ? 12 : 50, padding: '9px 12px', borderRadius: 10, background: 'rgba(8,3,15,0.82)', border: `1px solid ${colors.gold2}55`, color: colors.gold2, fontSize: 10, fontWeight: 800}}>UNE SEULE VUE</div>
      <div style={{position: 'absolute', bottom: 62, left: vertical ? 12 : 45, padding: '9px 12px', borderRadius: 10, background: 'rgba(8,3,15,0.82)', border: `1px solid ${colors.violet}66`, color: colors.soft, fontSize: 10, fontWeight: 800}}>BIENS · ÉQUIPE · SUIVI</div>
    </div>
  );
};

const IntroScene = ({vertical, duration, caption}) => (
  <SceneFade duration={duration} vertical={vertical}>
    <SceneLayout vertical={vertical}>
      <TextBlock vertical={vertical} width={vertical ? '100%' : '45%'}>
        <Kicker vertical={vertical}>Gestion locative simplifiée</Kicker>
        <Headline vertical={vertical}>Vos données sont <span style={{color: colors.violet}}>dispersées</span> ?</Headline>
        <Body vertical={vertical}>Biens, locataires, échéances et maintenance : MyImmoManagement rassemble ce qui est dispersé pour vous donner une vision claire de votre patrimoine.</Body>
        <Pill vertical={vertical} color={colors.gold2}>Une solution pensée pour les propriétaires</Pill>
      </TextBlock>
      <IntroVisual vertical={vertical}/>
    </SceneLayout>
    <Caption text={caption} duration={duration} vertical={vertical}/>
  </SceneFade>
);

const SolutionScene = ({vertical, duration, caption}) => (
  <SceneFade duration={duration} vertical={vertical}>
    <SceneLayout vertical={vertical}>
      <TextBlock vertical={vertical} width={vertical ? '100%' : '45%'}>
        <Kicker vertical={vertical}>La solution MIM</Kicker>
        <Headline vertical={vertical}>Gérez votre patrimoine <span style={{color: colors.gold2}}>simplement.</span></Headline>
        <Body vertical={vertical}>Une plateforme unique pour organiser vos biens, suivre vos occupants et garder le contrôle de votre activité.</Body>
        <div style={{display: 'flex', alignItems: 'center', gap: 12, marginTop: 3}}><div style={{width: 36, height: 36, display: 'grid', placeItems: 'center', borderRadius: 11, background: `${colors.green}18`, color: colors.green}}><Icon name="check" size={19}/></div><span style={{color: colors.soft, fontSize: 15, fontWeight: 700}}>Tout commence dans un espace unique.</span></div>
      </TextBlock>
      <SolutionVisual vertical={vertical}/>
    </SceneLayout>
    <Caption text={caption} duration={duration} vertical={vertical}/>
  </SceneFade>
);

const ProductScene = ({vertical, duration, caption, title, accent, children}) => (
  <SceneFade duration={duration} vertical={vertical}>
    <SceneLayout vertical={vertical}>
      <TextBlock vertical={vertical} width={vertical ? '100%' : '36%'}>
        <Kicker vertical={vertical}>Le quotidien en clair</Kicker>
        <Headline vertical={vertical} fontSize={vertical ? 49 : 54}>{title} <span style={{color: accent}}>.</span></Headline>
        <Body vertical={vertical}>Une vue opérationnelle, pensée pour avancer vite sans perdre le fil de votre patrimoine.</Body>
        <Pill vertical={vertical} color={accent}>{vertical ? 'Sur mobile et ordinateur' : 'Une vue claire, en temps réel'}</Pill>
      </TextBlock>
      <Window vertical={vertical}>{children}</Window>
    </SceneLayout>
    <Caption text={caption} duration={duration} vertical={vertical}/>
  </SceneFade>
);

const TeamScene = ({vertical, duration, caption}) => (
  <SceneFade duration={duration} vertical={vertical}>
    <SceneLayout vertical={vertical}>
      <TextBlock vertical={vertical} width={vertical ? '100%' : '36%'}>
        <Kicker vertical={vertical}>Une équipe organised</Kicker>
        <Headline vertical={vertical} fontSize={vertical ? 50 : 55}>Le bon espace, <span style={{color: colors.magenta}}>pour chacun.</span></Headline>
        <Body vertical={vertical}>Propriétaire, employé ou prestataire : chacun travaille avec les accès et les informations utiles à son rôle.</Body>
        <Pill vertical={vertical} color={colors.magenta}>Importez · Classez · Déléguez</Pill>
      </TextBlock>
      <Window vertical={vertical} title="app.mim-app.com/equipe"><TeamContent/></Window>
    </SceneLayout>
    <Caption text={caption} duration={duration} vertical={vertical}/>
  </SceneFade>
);

const CtaScene = ({vertical, duration, caption}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const rise = spring({frame, fps, config: {stiffness: 55, damping: 16}});
  return (
    <SceneFade duration={duration} vertical={vertical}>
      <AbsoluteFill style={{display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: vertical ? '180px 70px 170px' : '170px 120px 140px'}}>
        <div style={{display: 'flex', flexDirection: 'column', alignItems: 'center', gap: vertical ? 25 : 22, transform: `translateY(${(1 - rise) * 28}px)`}}>
          <Brand scale={vertical ? 1.15 : 1.28}/>
          <div style={{fontSize: vertical ? 57 : 69, lineHeight: 1.02, letterSpacing: -2.5, fontWeight: 800, maxWidth: vertical ? 880 : 980}}>Votre patrimoine mérite une <span style={{color: colors.gold2}}>vue claire.</span></div>
          <div style={{fontSize: vertical ? 22 : 24, color: colors.soft, maxWidth: vertical ? 760 : 700}}>Une gestion plus simple, plus claire, plus maîtrisée.</div>
          <div style={{display: 'flex', alignItems: 'center', gap: 12, padding: '16px 22px', borderRadius: 14, background: colors.gold2, color: '#211300', fontSize: vertical ? 18 : 20, fontWeight: 800, boxShadow: `0 15px 40px ${colors.gold2}44`}}><span>mim-app.com/createCompte</span><Icon name="arrow" size={20} color="#211300"/></div>
          <div style={{marginTop: 7, color: colors.dim, fontSize: 13, letterSpacing: 1.8, textTransform: 'uppercase'}}>Commencez dès aujourd’hui</div>
        </div>
      </AbsoluteFill>
      <Caption text={caption} duration={duration} vertical={vertical}/>
    </SceneFade>
  );
};

const Scene = ({scene, vertical}) => {
  if (scene.id === 'intro') return <IntroScene vertical={vertical} duration={scene.duration} caption={scene.caption}/>;
  if (scene.id === 'solution') return <SolutionScene vertical={vertical} duration={scene.duration} caption={scene.caption}/>;
  if (scene.id === 'dashboard') return <ProductScene vertical={vertical} duration={scene.duration} caption={scene.caption} title="Une vision claire" accent={colors.violet}><DashboardContent vertical={vertical}/></ProductScene>;
  if (scene.id === 'biens') return <ProductScene vertical={vertical} duration={scene.duration} caption={scene.caption} title="Vos biens, vos logements" accent={colors.gold2}><PropertyContent/></ProductScene>;
  if (scene.id === 'paiements') return <ProductScene vertical={vertical} duration={scene.duration} caption={scene.caption} title="Un suivi transparent" accent={colors.green}><PaymentContent/></ProductScene>;
  if (scene.id === 'maintenance') return <ProductScene vertical={vertical} duration={scene.duration} caption={scene.caption} title="Un incident suivi" accent={colors.magenta}><MaintenanceContent/></ProductScene>;
  if (scene.id === 'equipe') return <TeamScene vertical={vertical} duration={scene.duration} caption={scene.caption}/>;
  return <CtaScene vertical={vertical} duration={scene.duration} caption={scene.caption}/>;
};

export const MimVideo = ({vertical = false}) => (
  <AbsoluteFill style={{fontFamily: '"Segoe UI", Inter, Roboto, Arial, sans-serif', color: colors.text, WebkitFontSmoothing: 'antialiased'}}>
    <Background/>
    {scenes.map((scene) => <Sequence key={scene.id} from={scene.start} durationInFrames={scene.duration}><Scene scene={scene} vertical={vertical}/></Sequence>)}
    <Audio src={staticFile('music.wav')} volume={0.16}/>
    {scenes.map((scene) => <Sequence key={`voice-${scene.id}`} from={scene.start} durationInFrames={scene.duration}><Audio src={staticFile(`voice/${scene.clip}.mp3`)} volume={0.92}/></Sequence>)}
    <Chrome vertical={vertical}/>
  </AbsoluteFill>
);
