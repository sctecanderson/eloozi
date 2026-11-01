export function brandForeground(color: string): '#ffffff' | '#000000' {
  if (!/^#[\da-f]{6}$/i.test(color)) return '#ffffff';
  const c = [1,3,5].map(i=>parseInt(color.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);
  const luminance=c[0]*.2126+c[1]*.7152+c[2]*.0722;
  return (luminance+.05)/.05 >= 1.05/(luminance+.05) ? '#000000' : '#ffffff';
}
