#property strict
#property version   "1.01"
#property description "MT5 Batch Optimizer - symbol trade mode and initial market buy leverage"

#define REQUEST_FILE  "mt5batch-spec-request.txt"
#define RESULT_FILE   "mt5batch-spec-result.csv"

string TradeModeName(const long mode)
{
   switch(mode)
   {
      case SYMBOL_TRADE_MODE_DISABLED:  return "Disabled";
      case SYMBOL_TRADE_MODE_LONGONLY:  return "Long only";
      case SYMBOL_TRADE_MODE_SHORTONLY: return "Short only";
      case SYMBOL_TRADE_MODE_CLOSEONLY: return "Close only";
      case SYMBOL_TRADE_MODE_FULL:      return "Full";
      default:                          return "Unknown";
   }
}

bool ReadRequestSymbols(string &symbols[])
{
   ArrayResize(symbols, 0);
   int handle = FileOpen(REQUEST_FILE, FILE_READ | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(handle == INVALID_HANDLE)
   {
      Print("SymbolSpecProbe: cannot open request file err=", GetLastError());
      return false;
   }

   while(!FileIsEnding(handle))
   {
      string line = FileReadString(handle);
      StringTrimLeft(line);
      StringTrimRight(line);
      if(StringLen(line) == 0)
         continue;
      int n = ArraySize(symbols);
      ArrayResize(symbols, n + 1);
      symbols[n] = line;
   }
   FileClose(handle);
   return ArraySize(symbols) > 0;
}

double InitialMarketBuyMargin(const string sym)
{
   double price = SymbolInfoDouble(sym, SYMBOL_ASK);
   if(price <= 0.0)
      price = SymbolInfoDouble(sym, SYMBOL_BID);
   if(price <= 0.0)
      return 0.0;

   double margin = 0.0;
   if(!OrderCalcMargin(ORDER_TYPE_BUY, sym, 1.0, price, margin) || margin <= 0.0)
      return 0.0;
   return margin;
}

int LeverageFromInitialMarketBuy(const string sym)
{
   double margin = InitialMarketBuyMargin(sym);
   double contract_size = SymbolInfoDouble(sym, SYMBOL_TRADE_CONTRACT_SIZE);
   double price = SymbolInfoDouble(sym, SYMBOL_ASK);
   if(price <= 0.0)
      price = SymbolInfoDouble(sym, SYMBOL_BID);
   double notional = contract_size * price;
   if(margin > 0.0 && notional > 0.0)
   {
      int lev = (int)MathRound(notional / margin);
      if(lev >= 1)
         return lev;
   }

   double margin_initial_pct = SymbolInfoDouble(sym, SYMBOL_MARGIN_INITIAL);
   if(margin_initial_pct > 0.0 && margin_initial_pct < 100.0)
   {
      int lev = (int)MathRound(100.0 / margin_initial_pct);
      if(lev >= 1)
         return lev;
   }

   return 0;
}

bool PrepareSymbol(const string sym)
{
   if(sym == Symbol())
      return true;
   return SymbolSelect(sym, true);
}

bool WriteResults(const string &symbols[])
{
   int handle = FileOpen(RESULT_FILE, FILE_WRITE | FILE_TXT | FILE_ANSI | FILE_COMMON);
   if(handle == INVALID_HANDLE)
   {
      Print("SymbolSpecProbe: cannot write result file err=", GetLastError());
      return false;
   }

   FileWriteString(handle, "symbol,trade_mode,trade_mode_name,initial_margin_buy,leverage\r\n");
   for(int i = 0; i < ArraySize(symbols); i++)
   {
      string sym = symbols[i];
      if(!PrepareSymbol(sym))
      {
         FileWriteString(handle, sym + ",-1,Not found,0,0\r\n");
         continue;
      }
      long mode = SymbolInfoInteger(sym, SYMBOL_TRADE_MODE);
      double margin_buy = InitialMarketBuyMargin(sym);
      int leverage = LeverageFromInitialMarketBuy(sym);
      FileWriteString(handle,
         sym + "," + IntegerToString(mode) + "," + TradeModeName(mode) + "," +
         DoubleToString(margin_buy, 2) + "," + IntegerToString(leverage) + "\r\n");
   }
   FileClose(handle);
   Print("SymbolSpecProbe: wrote ", ArraySize(symbols), " symbol(s) to ", RESULT_FILE);
   return true;
}

void RunProbe()
{
   string symbols[];
   if(!ReadRequestSymbols(symbols))
      return;
   WriteResults(symbols);
}

int OnInit()
{
   if((bool)MQLInfoInteger(MQL_TESTER))
      RunProbe();
   return INIT_SUCCEEDED;
}

void OnTesterDeinit()
{
}
