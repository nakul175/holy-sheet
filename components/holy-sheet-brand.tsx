type HolySheetBrandProps = {
 onBlue?: boolean;
};

export default function HolySheetBrand({onBlue=false}:HolySheetBrandProps){
 return <img
  className={`aplyd-bot holy-sheet-brand-logo${onBlue?' aplyd-bot--on-blue':''}`}
  src="/brand/little-bot-heroes/holy-sheet.png"
  alt=""
  width="1254"
  height="1254"
  aria-hidden="true"
 />;
}
