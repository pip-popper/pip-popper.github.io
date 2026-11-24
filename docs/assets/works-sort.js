// Reorder only existing, already-public cards. No private data/API requests.
(() => {
  const selector=document.querySelector('#works-order'), grid=document.querySelector('#works .work-grid');
  if(!selector||!grid)return;
  const cards=[...grid.querySelectorAll('.work')];
  selector.addEventListener('change',()=>{
    const mode={new:'orderNew',kana:'orderKana',az:'orderAz'}[selector.value];if(!mode)return;
    [...cards].sort((a,b)=>Number(a.dataset[mode])-Number(b.dataset[mode])).forEach((card,i)=>{
      card.querySelector('.work-no').textContent=String(i+1).padStart(2,'0');
      card.style.setProperty('--i',i);grid.append(card);
    });
  });
})();
