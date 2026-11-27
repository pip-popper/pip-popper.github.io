// Reorder / filter only existing, already-public cards. No private data/API requests.
// 2026-11-27: the category switch (すべて / PIP POPPER / ソロ曲) only hides cards; the order is the one chosen in 表示順.
(() => {
  const selector=document.querySelector('#works-order'), grid=document.querySelector('#works .work-grid');
  if(!selector||!grid)return;
  const cards=[...grid.querySelectorAll('.work')];
  const buttons=[...document.querySelectorAll('#works .works-filter button')];
  const count=document.querySelector('#works .works-count span'), empty=document.querySelector('#works .works-empty');
  let category='all';
  const paint=()=>{
    const mode={new:'orderNew',kana:'orderKana',az:'orderAz'}[selector.value]??'orderNew';
    let n=0;
    [...cards].sort((a,b)=>Number(a.dataset[mode])-Number(b.dataset[mode])).forEach(card=>{
      const show=category==='all'||card.dataset.category===category;
      card.hidden=!show;
      if(show){card.querySelector('.work-no').textContent=String(n+1).padStart(2,'0');card.style.setProperty('--i',n);n++;}
      grid.append(card);
    });
    if(count)count.textContent=String(n);
    if(empty)empty.hidden=n>0;
  };
  selector.addEventListener('change',paint);
  buttons.forEach(button=>button.addEventListener('click',()=>{
    if(category===button.dataset.category)return;
    category=button.dataset.category;
    buttons.forEach(b=>b.setAttribute('aria-pressed',String(b===button)));
    paint();
  }));
})();
